import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/config";
import type { ConversationEvent } from "@orqestra/conversations";
import { openToolbox } from "@orqestra/tools";
import {
	fakeMcpServer,
	memoryOrrery,
	memoryStore,
} from "@orqestra/tools/testing";

// the push service, as web-push reaches it from @orqestra/conversations: each Alert recorded
const pushed: { status: string; url: string }[] = [];
mock.module(
	require.resolve("web-push", {
		paths: [require.resolve("@orqestra/conversations")],
	}),
	() => ({
		default: {
			sendNotification: async (_: unknown, payload: string) => {
				pushed.push(JSON.parse(payload));
			},
		},
	}),
);

// Smoke tests of the assembled worker: the runtime replying through the real @orqestra/conversations
// (lifecycle scenarios are tested there, runtime ones in src/runtime): needs TEST_DATABASE_URL, which src/test-env.ts sets up
const url = process.env.TEST_DATABASE_URL;
const { db } = await import("@orqestra/db");
const { asc, eq, sql } = await import("drizzle-orm");
const { limits, pushSubscription, usage, user } = await import(
	"@orqestra/db/schema"
);
const { config, skillFiles } = await import("@orqestra/config/live");
const { DEFAULT_LIMITS } = await import("@orqestra/config");
const { createConversations, MAX_SUBAGENTS_PER_USER_MESSAGE } = await import(
	"@orqestra/conversations"
);
const { startAgentWorker } = await import("./worker.ts");
const { MAX_SUBAGENT_STEPS } = await import("./runtime/tools.ts");

// one store, as the api and worker share one
const { store } = memoryStore();
const conversations = createConversations({
	store,
	config: config.current,
	skillFiles,
	// the api cancels Background Calls with the fake MCP Server too
	fetch: (input, init) => fetchFake(input, init),
});
const faux = fauxProvider({
	provider: "faux",
	// dollars per million tokens, so a request's cost can be checked against its tokens
	models: [
		{
			id: "faux-1",
			reasoning: true,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 4 },
		},
		// a tiny context window, so a short history already needs compaction
		{ id: "faux-small", contextWindow: 2000 },
	],
	tokensPerSecond: 400,
});
/** faux reports every request as free: prices its reply at the request's Model's price, as a real Provider of pi does. */
function withCost(stream: AssistantMessageEventStream, model: Model<Api>) {
	const push = stream.push.bind(stream);
	stream.push = (event) => {
		if (event.type === "done") calculateCost(model, event.message.usage);
		if (event.type === "error") calculateCost(model, event.error.usage);
		push(event);
	};
	return stream;
}
const fauxAgent: AgentDefinition = {
	id: "faux",
	name: "Faux",
	description: "test Agent",
	instructions: "You are a test.",
	models: ["faux/faux-1"],
	defaultModel: "faux/faux-1",
	thinking: {},
	default: false,
	memory: false,
	pickable: true,
	allModels: false,
	tools: ["search", "scrape"],
	skills: [],
	unavailableModels: [],
};
// a template whose Subagents get a Sandbox: it may use a Skill
const skilledAgent: AgentDefinition = {
	...fauxAgent,
	id: "skilled",
	instructions: "You carry out one task with a Skill.",
	pickable: false,
	skills: ["notes"],
};
const smallAgent: AgentDefinition = {
	...fauxAgent,
	id: "small",
	models: ["faux/faux-small"],
	defaultModel: "faux/faux-small",
	tools: [],
	compaction: { reserveTokens: 1000, keepRecentTokens: 50 },
};
// an Agent that may use the MCP Server `slow`, whose `crunch` it puts in the background
const mcpAgent: AgentDefinition = {
	...fauxAgent,
	id: "mcp",
	tools: ["search", "mcp:slow"],
};
const newSlow = () =>
	fakeMcpServer({
		era: "modern",
		tools: [
			{
				name: "crunch",
				inputSchema: { type: "object" },
				call: () => ({ task: { status: "working", pollIntervalMs: 250 } }),
			},
		],
	});
let slow = newSlow();
/** Search answers with no results; the MCP Server `slow` is the fake one. */
const fetchFake = (async (input: string | URL, init?: RequestInit) =>
	new URL(String(input)).hostname === "slow.example.com"
		? slow.fetch(input, init)
		: new Response(JSON.stringify({ results: [] }))) as typeof fetch;
const userId = "u1";
// a command that runs until it is canceled, one that writes a report, and the check attach makes
const orrery = memoryOrrery({
	exec: (command, files) => {
		if (command === "sleep 1000") return { running: true };
		if (command === "make report")
			files.set("out/report.txt", new TextEncoder().encode("first"));
		const report = files.get("out/report.txt");
		if (command.includes("realpath"))
			return report
				? { stdout: `${report.length}\n/workspace/out/report.txt` }
				: { exit_code: 1 };
		return {};
	},
});

// Reads SSE events from a stream until `until` returns true
async function collect(
	stream: ReadableStream,
	until: (events: ConversationEvent[]) => boolean,
	onEvent?: (event: ConversationEvent) => void,
) {
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	const events: ConversationEvent[] = [];
	let buffer = "";
	while (!until(events)) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += value;
		const frames = buffer.split("\n\n");
		buffer = frames.pop() ?? "";
		for (const frame of frames) {
			const data = frame.match(/^data: (.*)$/m)?.[1];
			if (!data) continue;
			const event = JSON.parse(data) as ConversationEvent;
			events.push(event);
			onEvent?.(event);
		}
	}
	await reader.cancel();
	return events;
}

const text = (events: ConversationEvent[], kind: "text" | "thinking") =>
	events
		.map((e) => (e.type === "delta" && e.kind === kind ? e.delta : ""))
		.join("");

// Subagents run alongside their parent, so each request takes the next faux reply meant for whoever sent it,
// told apart by the system prompt it starts with
function script(replies: {
	parent: FauxResponseStep[];
	sub?: FauxResponseStep[];
}) {
	const queues = {
		parent: [...replies.parent],
		sub: [...(replies.sub ?? [])],
		title: [fauxAssistantMessage("T")],
	};
	const total = Object.values(queues).reduce((n, q) => n + q.length, 0);
	faux.setResponses(
		Array.from({ length: total }, () => (context, ...rest) => {
			const head = JSON.stringify(context.messages[0]);
			const queue = head.includes("Write a title")
				? queues.title
				: head.includes("You carry out one task")
					? queues.sub
					: queues.parent;
			const next = queue.shift();
			if (!next) throw new Error(`No faux reply left for ${head.slice(0, 80)}`);
			return typeof next === "function" ? next(context, ...rest) : next;
		}),
	);
}

/** The Usage recorded for a top-level Conversation, oldest first. */
const usageOf = (conversationId: string) =>
	db
		.select()
		.from(usage)
		.where(eq(usage.conversationId, conversationId))
		.orderBy(asc(usage.id));
/** What faux-1's prices make of a request's tokens. */
const priced = (u: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}) =>
	(u.inputTokens * 1 +
		u.outputTokens * 2 +
		u.cacheReadTokens * 0.5 +
		u.cacheWriteTokens * 4) /
	1e6;

/** Adds the test's faux Provider, Agents, Sandbox and Tools to the loaded config; again after each reload replaces it. */
async function patch() {
	const loaded = await config.current();
	// with a baseUrl, so faux is in the Catalog and a test can configure it as a Provider
	loaded.registry.registerProvider({
		...faux.provider,
		baseUrl: faux.models[0].baseUrl,
		stream: (model, ...rest) =>
			withCost(faux.provider.stream(model, ...rest), model),
		streamSimple: (model, ...rest) =>
			withCost(faux.provider.streamSimple(model, ...rest), model),
	});
	// faux-1 is loaded from the database while a test configures faux as a Provider
	loaded.models.push(
		...faux.models.filter(
			(m) =>
				!loaded.models.some((l) => l.provider === m.provider && l.id === m.id),
		),
	);
	loaded.agents.push(fauxAgent, skilledAgent, smallAgent, mcpAgent);
	loaded.mcpServers.slow = {
		name: "Slow",
		url: "https://slow.example.com/mcp",
		headers: {},
	};
	loaded.sandboxProvider = {
		url: "http://orrery",
		token: "t",
		cpu: 1,
		memory: 1,
	};
	loaded.skills.notes = {
		versionId: 0,
		description: "Takes notes",
		disableModelInvocation: false,
	};
	loaded.tools.search = {
		provider: "tavily",
		apiKey: "k",
		baseUrl: "https://api.tavily.com",
	};
}

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 100; i++) {
		const v = await read();
		if (ok(v)) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}

describe.skipIf(!url)(
	"Runs replied by the runtime (Postgres + faux provider)",
	() => {
		let stopWorker: () => Promise<void>;
		const start = async () => {
			// faux replies are one shared queue, so runs go one at a time
			stopWorker = await startAgentWorker(config.current, {
				concurrency: 1,
				orrery: () => orrery.client,
				store,
				toolbox: (services, allowed, options) =>
					openToolbox(services, allowed, { ...options, fetch: fetchFake }),
				fetch: fetchFake,
			});
		};

		beforeAll(async () => {
			await patch();
			await start();
		});
		afterAll(async () => {
			await stopWorker?.();
			await config.close();
		});

		beforeEach(async () => {
			// Subagents may outlive a test: stop them so they neither linger nor hold up stopping the worker
			await db.execute(
				sql`select pg_notify('conversation_stop', id::text) from conversation where status = 'running'`,
			);
			await db.execute(
				sql`truncate conversation, scheduled_task, usage, limits, push_subscription, "user" cascade`,
			);
		});

		it("streams a reply over SSE, then saves it and a title", async () => {
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			faux.setResponses([
				async () => {
					await gate;
					return fauxAssistantMessage([
						fauxThinking("let me think"),
						fauxText("Hello there"),
					]);
				},
				fauxAssistantMessage("A greeting"),
			]);

			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "hi",
			});
			const stream = await conversations.subscribe(
				userId,
				id,
				new AbortController().signal,
			);
			// the reply starts only once the SSE stream is listening
			release();
			const events = await collect(
				stream as ReadableStream,
				(es) =>
					es.some((e) => e.type === "start") && es.at(-1)?.type === "saved",
			);

			expect(text(events, "thinking")).toBe("let me think");
			expect(text(events, "text")).toBe("Hello there");

			const view = await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.title === "A greeting",
			);
			expect(view?.status).toBe("idle");
			expect(view?.readOnly).toBe(false);
			expect(view?.messages.map((m) => m.message.role)).toEqual([
				"user",
				"assistant",
			]);
			const reply = view?.messages[1];
			expect(reply?.model).toBe("faux/faux-1");
			expect((reply?.message as AssistantMessage).content).toMatchObject([
				{ type: "thinking", thinking: "let me think" },
				{ type: "text", text: "Hello there" },
			]);
		});

		it("gives a Subagent at its step limit one last request without Tools for its answer", async () => {
			let first: { messages: { toolsAdded?: unknown }[] } | undefined;
			let last: unknown;
			script({
				parent: [
					fauxAssistantMessage(
						fauxToolCall("subagent", { tasks: [{ brief: "dig" }] }),
					),
					fauxAssistantMessage("Digging"),
					fauxAssistantMessage("Done"),
				],
				sub: [
					(context) => {
						first = context as typeof first;
						return fauxAssistantMessage([
							fauxText("step 1"),
							fauxToolCall("search", { query: "more" }),
						]);
					},
					...Array.from({ length: MAX_SUBAGENT_STEPS - 2 }, (_, i) =>
						fauxAssistantMessage([
							fauxText(`step ${i + 2}`),
							fauxToolCall("search", { query: "more" }),
						]),
					),
					(context) => {
						last = context;
						return fauxAssistantMessage("what I found");
					},
				],
			});
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "dig deep",
			});
			const view = await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.status === "idle" && v.messages.length === 6,
			);
			// under the default depth limit of 2, a Subagent may start Subagents in turn
			expect(JSON.stringify(first?.messages[0].toolsAdded)).toContain(
				"subagent_message",
			);
			expect(JSON.stringify(last)).toContain("step limit");
			const notified = JSON.stringify(view?.messages[4].message.content);
			expect(notified).toContain('status=\\"partial\\"');
			expect(notified).toContain("what I found");
			expect(view?.subagents[0].outcome).toBe("partial");
		});

		it("cancels the command a Subagent runs when the User stops the parent", async () => {
			script({
				parent: [
					fauxAssistantMessage(
						fauxToolCall("subagent", {
							tasks: [{ brief: "wait", template: "skilled" }],
						}),
					),
					fauxAssistantMessage("Waiting"),
				],
				sub: [
					fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1000" })),
				],
			});
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "wait",
			});
			const calls = (prefix: string) =>
				Promise.resolve(orrery.calls.filter((c) => c.startsWith(prefix)));
			await waitFor(
				() => calls("createExec"),
				(c) => c.some((x) => x.endsWith(" sleep 1000")),
			);
			await conversations.stop(userId, id);
			const canceled = await waitFor(
				() => calls("cancelExec"),
				(c) => c.length > 0,
			);
			expect(canceled).toHaveLength(1);
			const view = await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.subagents[0]?.outcome === "stopped",
			);
			expect(view?.subagents[0].outcome).toBe("stopped");
		});

		it("keeps the file attach saw: the Sandbox changing or deleting it later changes nothing the User downloads", async () => {
			script({
				parent: [
					fauxAssistantMessage(
						fauxToolCall("bash", { command: "make report" }),
					),
					fauxAssistantMessage(
						fauxToolCall("attach", { path: "out/report.txt" }),
					),
					fauxAssistantMessage("Here it is"),
				],
			});
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "report",
			});
			const view = await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.status === "idle" && v.messages.length === 6,
			);
			expect(view?.messages[4].message).toMatchObject({
				isError: false,
				details: {
					attachment: {
						path: "/workspace/out/report.txt",
						name: "report.txt",
						size: 5,
					},
				},
			});
			const download = async () => {
				const got = await conversations.openFile(userId, id, "report.txt");
				if (!("file" in got)) throw new Error(got.error);
				return new Response(got.file.body).text();
			};
			const {
				rows: [row],
			} = await db.execute<{ sandbox_id: string }>(
				sql`select sandbox_id from conversation where id = ${id}`,
			);
			orrery
				.files(row.sandbox_id)
				.set("out/report.txt", new TextEncoder().encode("second"));
			expect(await download()).toBe("first");
			await orrery.client.deleteSandbox(row.sandbox_id);
			expect(await download()).toBe("first");
		});

		it("records Usage for each step of a Turn and for its title, priced at the Model's price", async () => {
			script({
				parent: [
					fauxAssistantMessage(fauxToolCall("search", { query: "news" })),
					fauxAssistantMessage("Nothing new"),
				],
			});
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "any news?",
			});
			const rows = await waitFor(
				() => usageOf(id),
				(r) => r.length === 3,
			);
			expect(rows.map((r) => r.purpose).sort()).toEqual([
				"step",
				"step",
				"title",
			]);
			for (const row of rows) {
				expect(row).toMatchObject({
					userId,
					agentId: "faux",
					agentName: "Faux",
					provider: "faux",
					modelId: "faux-1",
					scheduledTaskId: null,
				});
				expect(row.outputTokens).toBeGreaterThan(0);
				expect(row.cost).toBeGreaterThan(0);
				expect(row.cost).toBeCloseTo(priced(row), 12);
			}
		});

		it("costs requests at an Admin's price from when it is set, keeping what was recorded, and at the Catalog's once it is cleared", async () => {
			const [model] = faux.models;
			await config.providers.save({
				id: "faux",
				apiKey: "k",
				baseUrl: model.baseUrl,
			});
			await config.providers.setModelEnabled({
				providerId: "faux",
				modelId: "faux-1",
				enabled: true,
			});
			await patch();
			const turn = async () => {
				script({ parent: [fauxAssistantMessage("Hello")] });
				const id = await conversations.send(userId, {
					agentId: "faux",
					text: "hi",
				});
				return waitFor(
					() => usageOf(id),
					(r) => r.length === 2,
				);
			};
			const setPrice = async (cost: typeof model.cost | null) => {
				await config.providers.setModelPrice({
					providerId: "faux",
					modelId: "faux-1",
					cost,
				});
				await patch();
			};
			try {
				const before = await turn();
				await setPrice({ input: 10, output: 20, cacheRead: 5, cacheWrite: 40 });
				const custom = await turn();
				await setPrice(null);
				const cleared = await turn();

				for (const row of [...before, ...cleared])
					expect(row.cost).toBeCloseTo(priced(row), 12);
				for (const row of custom) {
					expect(row.cost).toBeGreaterThan(0);
					expect(row.cost).toBeCloseTo(priced(row) * 10, 12);
				}
				expect(await usageOf(before[0].conversationId)).toEqual(before);
			} finally {
				await config.providers.delete("faux");
				await patch();
			}
		});

		it("records a compaction's request as compaction Usage", async () => {
			// first Turn: a long question, its reply and the title; second: the compaction, then the reply
			faux.setResponses([
				fauxAssistantMessage("ok"),
				fauxAssistantMessage("T"),
				fauxAssistantMessage("a summary"),
				fauxAssistantMessage("ok again"),
			]);
			const id = await conversations.send(userId, {
				agentId: "small",
				text: "word ".repeat(1500),
			});
			await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.status === "idle" && !!v.title,
			);
			// long enough to be kept, so the first Turn is what gets summarized
			await conversations.send(userId, {
				conversationId: id,
				text: "more ".repeat(100),
			});
			const rows = await waitFor(
				() => usageOf(id),
				(r) => r.length === 4,
			);
			expect(rows.map((r) => r.purpose).sort()).toEqual([
				"compaction",
				"step",
				"step",
				"title",
			]);
			expect(rows.every((r) => r.modelId === "faux-small")).toBe(true);
		});

		it("records a Subagent's requests for the top-level Conversation's User, under the Agent that sent them", async () => {
			script({
				parent: [
					fauxAssistantMessage(
						fauxToolCall("subagent", {
							tasks: [{ brief: "dig" }, { brief: "note", template: "skilled" }],
						}),
					),
					...Array.from({ length: 3 }, () => fauxAssistantMessage("Done")),
				],
				sub: [fauxAssistantMessage("found"), fauxAssistantMessage("found")],
			});
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "dig",
			});
			const rows = await waitFor(
				() => usageOf(id),
				(r) => r.filter((x) => x.agentId !== "faux").length === 2,
			);
			const subs = rows.filter((r) => r.agentId !== "faux");
			expect(
				subs.map((r) => [r.agentId, r.agentName, r.userId, r.purpose]),
			).toEqual(
				expect.arrayContaining([
					[null, null, userId, "step"],
					["skilled", "Faux", userId, "step"],
				]),
			);
			// the parent replies to both Notifications before the next test's replies are queued
			await waitFor(
				() => conversations.get(userId, id),
				(v) =>
					v?.status === "idle" &&
					v.messages.filter((m) => m.subagentId).length === 2 &&
					v.messages.at(-1)?.message.role === "assistant",
			);
		});

		it("records Usage of an Incognito Conversation, and keeps a Conversation's Usage once it is deleted", async () => {
			script({ parent: [fauxAssistantMessage("Hello")] });
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "hi",
				incognito: true,
			});
			await waitFor(
				() => usageOf(id),
				(r) => r.length === 2,
			);
			await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.status === "idle" && !!v.title,
			);
			await conversations.delete(userId, id);
			expect(await conversations.get(userId, id)).toBeFalsy();
			expect(await usageOf(id)).toHaveLength(2);
		});

		it("records a Firing's Usage with its Scheduled Task", async () => {
			script({ parent: [fauxAssistantMessage("The news")] });
			const taskId = await conversations.tasks.create(userId, {
				name: "News",
				prompt: "Summarize the news",
				agentId: "faux",
				model: "faux/faux-1",
				thinking: "off",
				schedule: {
					kind: "once",
					at: new Date(Date.now() + 300).toISOString(),
				},
				endsAt: null,
				timeZone: "UTC",
				incognito: false,
				alertOnComplete: false,
				enabled: true,
			});
			const rows = await waitFor(
				() => db.select().from(usage).where(eq(usage.scheduledTaskId, taskId)),
				(r) => r.length === 2,
			);
			expect(rows.map((r) => r.userId)).toEqual([userId, userId]);
		});

		it("records a failed request the Provider reported usage for, but not one that never reached it", async () => {
			faux.setResponses([
				() => {
					throw new Error("connection refused");
				},
				fauxAssistantMessage("half", {
					stopReason: "error",
					errorMessage: "overloaded",
				}),
			]);
			const unreached = await conversations.send(userId, {
				agentId: "faux",
				text: "hi",
			});
			await waitFor(
				() => conversations.get(userId, unreached),
				(v) => v?.status === "failed",
			);
			const failed = await conversations.send(userId, {
				agentId: "faux",
				text: "hi",
			});
			const [row] = await waitFor(
				() => usageOf(failed),
				(r) => r.length === 1,
			);
			expect(row.purpose).toBe("step");
			expect(row.outputTokens).toBeGreaterThan(0);
			expect(await usageOf(unreached)).toEqual([]);
		});

		describe("Spending Limit", () => {
			// straight into the table: saving through config would reload it, dropping the faux Agents; each request reads it afresh anyway
			const limitTo = async (usd: number | null) => {
				const saved = {
					...DEFAULT_LIMITS,
					spendingLimit:
						usd === null
							? { mode: "unlimited" as const }
							: { mode: "limited" as const, usd },
				};
				await db
					.insert(limits)
					.values({ id: 1, ...saved })
					.onConflictDoUpdate({ target: limits.id, set: saved });
			};

			// sending is refused once the limit is used up (see the api's tests), so these use it up during the Run
			it("fails a Run whose User has used up their limit, sending no further request, and a retry once it is raised succeeds", async () => {
				await limitTo(1);
				faux.setResponses([
					async () => {
						await limitTo(0);
						return fauxAssistantMessage(fauxToolCall("missing", {}));
					},
					fauxAssistantMessage("Hello"),
				]);
				const id = await conversations.send(userId, {
					agentId: "faux",
					text: "hi",
				});
				const view = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "failed",
				);
				expect(view?.failure).toBe("spending_limit");
				expect(faux.getPendingResponseCount()).toBe(1);
				expect(await usageOf(id)).toHaveLength(1);

				await limitTo(1);
				faux.setResponses([
					fauxAssistantMessage("Hello"),
					fauxAssistantMessage("T"),
				]);
				await conversations.retry(userId, id);
				const retried = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && !!v.title,
				);
				expect(retried?.messages.at(-1)?.message.role).toBe("assistant");
				expect(retried?.failure).toBeNull();
			});

			it("checks a User's own limit before the unlimited default", async () => {
				await db.insert(user).values({
					id: userId,
					name: "U",
					lastActiveAt: new Date(),
					spendingLimit: { mode: "limited", usd: 1 },
				});
				faux.setResponses([
					async () => {
						await db
							.update(user)
							.set({ spendingLimit: { mode: "limited", usd: 0 } });
						return fauxAssistantMessage(fauxToolCall("missing", {}));
					},
					fauxAssistantMessage("Hello"),
				]);
				const id = await conversations.send(userId, {
					agentId: "faux",
					text: "hi",
				});
				const view = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "failed",
				);
				expect(view?.failure).toBe("spending_limit");
				expect(faux.getPendingResponseCount()).toBe(1);
				faux.setResponses([]);
			});

			it("skips a Firing due once the limit is used up, and fails one whose Run uses it up midway", async () => {
				const fireNow = (name: string) =>
					conversations.tasks.create(userId, {
						name,
						prompt: "Summarize the news",
						agentId: "faux",
						model: "faux/faux-1",
						thinking: "off",
						schedule: {
							kind: "once",
							at: new Date(Date.now() + 300).toISOString(),
						},
						endsAt: null,
						timeZone: "UTC",
						incognito: false,
						alertOnComplete: false,
						enabled: true,
					});
				const firstFiring = async (taskId: string) =>
					(await conversations.tasks.get(userId, taskId))?.firings[0];

				faux.setResponses([
					async () => {
						// used up by this step, so the next is refused
						await limitTo(0);
						return fauxAssistantMessage(fauxToolCall("missing", {}));
					},
				]);
				const midwayId = await fireNow("Midway");
				const midway = await waitFor(
					() => firstFiring(midwayId),
					(f) => f?.outcome === "failed",
				);
				expect(midway?.reason).toBeNull();

				const skippedId = await fireNow("Skipped");
				const skipped = await waitFor(
					() => firstFiring(skippedId),
					(f) => !!f,
				);
				expect(skipped).toMatchObject({
					outcome: "skipped",
					reason: "spending_limit",
					conversationId: null,
				});
			});

			it("leaves the title for a Turn that ends once the limit allows, without failing the Run", async () => {
				faux.setResponses([
					async () => {
						// used up by the time the title is asked for
						await limitTo(0);
						return fauxAssistantMessage("Hello");
					},
				]);
				const id = await conversations.send(userId, {
					agentId: "faux",
					text: "hi",
				});
				const view = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && v.messages.length === 2,
				);
				expect(view?.title).toBeNull();

				await limitTo(null);
				faux.setResponses([
					fauxAssistantMessage("Hello again"),
					fauxAssistantMessage("Greetings"),
				]);
				await conversations.send(userId, { conversationId: id, text: "hi" });
				const titled = await waitFor(
					() => conversations.get(userId, id),
					(v) => !!v?.title,
				);
				expect(titled?.title).toBe("Greetings");
			});

			it("fails a Subagent once the limit is used up, and its Notification still wakes the parent, whose Run fails", async () => {
				let release!: () => void;
				const gate = new Promise<void>((r) => {
					release = r;
				});
				script({
					parent: [
						fauxAssistantMessage(
							fauxToolCall("subagent", { tasks: [{ brief: "dig" }] }),
						),
						fauxAssistantMessage("Digging"),
					],
					sub: [
						async () => {
							await gate;
							return fauxAssistantMessage(
								fauxToolCall("search", { query: "more" }),
							);
						},
					],
				});
				const id = await conversations.send(userId, {
					agentId: "faux",
					text: "dig",
				});
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && !!v.title,
				);
				await limitTo(0);
				release();
				const view = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "failed",
				);
				expect(view?.subagents[0].outcome).toBe("failed");
				expect(view?.failure).toBe("spending_limit");
				// the Notification reached the parent, waiting for a retry
				expect(view?.messages.at(-1)?.subagentId).toBeTruthy();
			});

			it("tells another failure from a used-up limit", async () => {
				faux.setResponses([
					() => {
						throw new Error("connection refused");
					},
				]);
				const id = await conversations.send(userId, {
					agentId: "faux",
					text: "hi",
				});
				const view = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "failed",
				);
				expect(view?.failure).toBe("error");
			});
		});

		it("records a stopped request with the usage the Provider reported", async () => {
			// a stopped reply is titled too
			faux.setResponses([
				fauxAssistantMessage("word ".repeat(2000)),
				fauxAssistantMessage("T"),
			]);
			const stopped = await conversations.send(userId, {
				agentId: "faux",
				text: "talk",
			});
			const stream = await conversations.subscribe(
				userId,
				stopped,
				new AbortController().signal,
			);
			await collect(stream as ReadableStream, (es) =>
				es.some((e) => e.type === "delta"),
			);
			await conversations.stop(userId, stopped);
			const rows = await waitFor(
				() => usageOf(stopped),
				(r) => r.length === 2,
			);
			const cut = rows.find((r) => r.purpose === "step");
			expect(cut?.inputTokens).toBeGreaterThan(0);
			expect(
				(await conversations.get(userId, stopped))?.messages[1],
			).toMatchObject({
				message: { stopReason: "aborted" },
			});
		});

		describe("Background Calls", () => {
			beforeEach(() => {
				slow = newSlow();
			});
			const finishTask = (text: string) =>
				Object.assign(slow.tasks.get("task-1") ?? {}, {
					status: "completed",
					result: { content: [{ type: "text", text }] },
				});
			const crunch = () =>
				fauxAssistantMessage(fauxToolCall("slow__crunch", {}));
			const notifications = (
				v: Awaited<ReturnType<typeof conversations.get>>,
			) => v?.messages.filter((m) => m.backgroundCallId) ?? [];

			it("tells the Agent at once the call went to the background, and its result wakes the Conversation once done", async () => {
				let woken: unknown;
				script({
					parent: [
						crunch(),
						fauxAssistantMessage("Crunching in the background"),
						(context) => {
							woken = context.messages;
							return fauxAssistantMessage("The answer is 42");
						},
					],
				});
				const id = await conversations.send(userId, {
					agentId: "mcp",
					text: "crunch it",
				});
				const ran = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && v.messages.length === 4,
				);
				const result = ran?.messages[2].message;
				expect(JSON.stringify(result)).toContain("background");
				expect(ran?.backgroundCalls).toMatchObject([
					{
						conversationId: id,
						toolCallId: (result as { toolCallId: string }).toolCallId,
						status: "running",
					},
				]);
				expect(
					(result as { details?: { backgroundCall?: string } }).details
						?.backgroundCall,
				).toBe(ran?.backgroundCalls[0].id);

				finishTask("42 it is");
				const done = await waitFor(
					() => conversations.get(userId, id),
					(v) =>
						v?.status === "idle" &&
						v.messages.at(-1)?.message.role === "assistant" &&
						v.messages.length === 6,
				);
				expect(done?.backgroundCalls[0].status).toBe("completed");
				const [notified] = notifications(done);
				expect(notified.backgroundCallId).toBe(
					done?.backgroundCalls[0].id ?? "",
				);
				const frame = JSON.stringify(notified.message.content);
				expect(frame).toContain("<task-notification");
				expect(frame).toContain('server=\\"Slow\\"');
				expect(frame).toContain('tool=\\"crunch\\"');
				expect(frame).toContain('status=\\"completed\\"');
				expect(JSON.stringify(woken)).toContain("42 it is");
				expect(slow.requests.map((r) => r.method)).not.toContain(
					"tasks/cancel",
				);
			});

			it("delivers a result that comes in during the Run between two steps of that Run", async () => {
				let next: unknown;
				script({
					parent: [
						crunch(),
						async () => {
							finishTask("in time");
							await waitFor(
								() => db.execute(sql`select 1 from inbox`),
								(r) => r.rows.length > 0,
							);
							return fauxAssistantMessage(
								fauxToolCall("search", { query: "more" }),
							);
						},
						(context) => {
							next = context.messages;
							return fauxAssistantMessage("Used it");
						},
					],
				});
				const id = await conversations.send(userId, {
					agentId: "mcp",
					text: "crunch it",
				});
				const view = await waitFor(
					() => conversations.get(userId, id),
					(v) =>
						v?.status === "idle" &&
						v.messages.at(-1)?.message.role === "assistant" &&
						notifications(v).length === 1,
				);
				expect(JSON.stringify(next)).toContain("in time");
				// one Run: nothing woke it again
				expect(view?.messages.map((m) => m.message.role)).toEqual([
					"user",
					"assistant",
					"toolResult",
					"assistant",
					"toolResult",
					"user",
					"assistant",
				]);
			});

			it("holds a result that comes in while the Agent waits on its Question until the User answers", async () => {
				let answered: unknown;
				script({
					parent: [
						fauxAssistantMessage([
							fauxToolCall("slow__crunch", {}),
							fauxToolCall("ask_user", { question: "Which one?" }),
						]),
						(context) => {
							answered = context.messages;
							return fauxAssistantMessage("Thanks");
						},
					],
				});
				const id = await conversations.send(userId, {
					agentId: "mcp",
					text: "crunch it",
				});
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && !!v.awaitingReply,
				);
				finishTask("while asking");
				const held = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.backgroundCalls[0]?.status === "completed",
				);
				await new Promise((r) => setTimeout(r, 300));
				const still = await conversations.get(userId, id);
				expect(still?.status).toBe("idle");
				expect(still?.messages.length).toBe(held?.messages.length);

				await conversations.send(userId, { conversationId: id, text: "B" });
				await waitFor(
					() => conversations.get(userId, id),
					(v) =>
						v?.status === "idle" &&
						v.messages.at(-1)?.message.role === "assistant" &&
						notifications(v).length === 1,
				);
				expect(JSON.stringify(answered)).toContain("while asking");
			});

			/** Alerts reach the push service from now on; the input of a task due right away. */
			const alerted = async () => {
				Object.assign(process.env, {
					VAPID_PUBLIC_KEY: "public",
					VAPID_PRIVATE_KEY: "private",
					VAPID_SUBJECT: "mailto:admin@example.com",
				});
				pushed.length = 0;
				await db.insert(pushSubscription).values({
					userId,
					endpoint: "https://push.example/u1",
					keys: { p256dh: "p", auth: "a" },
				});
			};
			const input = () => ({
				name: "Crunch",
				prompt: "crunch it",
				agentId: "mcp",
				model: "faux/faux-1",
				thinking: "off" as const,
				schedule: {
					kind: "once" as const,
					at: new Date(Date.now() + 300).toISOString(),
				},
				endsAt: null,
				timeZone: "UTC",
				incognito: false,
				alertOnComplete: true,
				enabled: true,
			});
			// a one-time task also tells it has finished, at its Firing
			const runAlerts = async () =>
				pushed.filter((p) => p.status !== "finished");

			it("ends a Firing, with its Alert, only once its Background Calls have ended; one due meanwhile is skipped", async () => {
				await alerted();
				script({
					parent: [
						crunch(),
						fauxAssistantMessage("Crunching"),
						fauxAssistantMessage("The answer is 42"),
					],
				});
				const taskId = await conversations.tasks.create(userId, input());
				const firings = async () =>
					(await conversations.tasks.get(userId, taskId))?.firings ?? [];
				const [first] = await waitFor(firings, (f) => !!f[0]?.conversationId);
				const id = first.conversationId as string;
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && v.messages.length === 4,
				);
				expect((await firings())[0].outcome).toBe("running");
				expect(await runAlerts()).toEqual([]);

				// due again while the first has no outcome yet
				await conversations.tasks.update(userId, taskId, input());
				const skipped = await waitFor(firings, (f) => f.length === 2);
				expect(skipped[0]).toMatchObject({
					outcome: "skipped",
					reason: "previous_running",
				});
				expect(skipped[1].outcome).toBe("running");

				finishTask("42 it is");
				const ended = await waitFor(
					firings,
					(f) => f[1].outcome === "completed",
				);
				expect(ended[1].conversationId).toBe(id);
				const [alert] = await waitFor(runAlerts, (p) => p.length === 1);
				expect(alert).toMatchObject({
					status: "completed",
					url: `/c/${id}`,
				});
			});

			it("ends a Firing waiting on its Question as a Question once its Background Call ends", async () => {
				await alerted();
				script({
					parent: [
						fauxAssistantMessage([
							fauxToolCall("slow__crunch", {}),
							fauxToolCall("ask_user", { question: "Which one?" }),
						]),
					],
				});
				const taskId = await conversations.tasks.create(userId, input());
				const firing = async () =>
					(await conversations.tasks.get(userId, taskId))?.firings[0];
				const asked = await waitFor(firing, (f) => !!f?.conversationId);
				const id = asked?.conversationId as string;
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && !!v.awaitingReply,
				);
				expect((await firing())?.outcome).toBe("running");
				expect(await runAlerts()).toEqual([]);

				finishTask("while asking");
				await waitFor(firing, (f) => f?.outcome === "question");
				const [alert] = await waitFor(runAlerts, (p) => p.length === 1);
				expect(alert).toMatchObject({ status: "question", url: `/c/${id}` });
			});

			/** A task due right away whose Run puts a call in the background and ends; its Firing waits for the call. */
			const waitingFiring = async () => {
				await alerted();
				script({
					parent: [crunch(), fauxAssistantMessage("Crunching")],
				});
				const taskId = await conversations.tasks.create(userId, input());
				const firing = async () =>
					(await conversations.tasks.get(userId, taskId))?.firings[0];
				const started = await waitFor(firing, (f) => !!f?.conversationId);
				const id = started?.conversationId as string;
				const ran = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && v.messages.length === 4,
				);
				expect((await firing())?.outcome).toBe("running");
				return {
					id,
					toolCallId: ran?.backgroundCalls[0].toolCallId ?? "",
					firing,
				};
			};

			it("ends a Firing, with its Alert, once the User cancels the call it waited for", async () => {
				const { id, toolCallId, firing } = await waitingFiring();
				await conversations.cancelBackgroundCall(userId, id, toolCallId);
				await waitFor(firing, (f) => f?.outcome === "completed");
				const [alert] = await waitFor(runAlerts, (p) => p.length === 1);
				expect(alert).toMatchObject({ status: "completed", url: `/c/${id}` });
			});

			it("ends a Firing partial, with no Alert, once the User stops it while it waits for its call", async () => {
				const { id, firing } = await waitingFiring();
				await conversations.stop(userId, id);
				await waitFor(firing, (f) => f?.outcome === "partial");
				await new Promise((r) => setTimeout(r, 300));
				expect(await runAlerts()).toEqual([]);
			});

			const cancels = () =>
				slow.requests.filter((r) => r.method === "tasks/cancel");
			/** Sends "crunch it" and waits for the Run that put the call in the background to end. */
			const crunched = async () => {
				const id = await conversations.send(userId, {
					agentId: "mcp",
					text: "crunch it",
				});
				const ran = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && v.messages.length === 4,
				);
				return { id, toolCallId: ran?.backgroundCalls[0].toolCallId ?? "" };
			};

			it("cancels a call at the User's request without waking the Agent, which learns of it with the next message", async () => {
				let next: unknown;
				script({
					parent: [
						crunch(),
						fauxAssistantMessage("Crunching"),
						(context) => {
							next = context.messages;
							return fauxAssistantMessage("Noted");
						},
					],
				});
				const { id, toolCallId } = await crunched();
				expect(
					await conversations.cancelBackgroundCall("u2", id, toolCallId),
				).toBe(false);
				expect(
					await conversations.cancelBackgroundCall(userId, id, toolCallId),
				).toBe(true);
				await waitFor(
					async () => cancels(),
					(c) => c.length === 1,
				);
				const view = await conversations.get(userId, id);
				expect(view?.backgroundCalls[0].status).toBe("cancelled");
				// ended: nothing left to cancel
				expect(
					await conversations.cancelBackgroundCall(userId, id, toolCallId),
				).toBe(false);
				await new Promise((r) => setTimeout(r, 300));
				const still = await conversations.get(userId, id);
				expect(still?.status).toBe("idle");
				// the Notification, waiting in the inbox
				expect(still?.messages.length).toBe(5);

				await conversations.send(userId, { conversationId: id, text: "and?" });
				await waitFor(
					() => conversations.get(userId, id),
					(v) =>
						v?.status === "idle" &&
						v.messages.at(-1)?.message.role === "assistant" &&
						v.messages.length === 7,
				);
				expect(JSON.stringify(next)).toContain("The User cancelled the call");
			});

			it("cancels the calls of a stopped Conversation without waking it", async () => {
				script({
					parent: [crunch(), fauxAssistantMessage("Crunching")],
				});
				const { id } = await crunched();
				await conversations.stop(userId, id);
				await waitFor(
					async () => cancels(),
					(c) => c.length === 1,
				);
				const view = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.backgroundCalls[0].status === "cancelled",
				);
				await new Promise((r) => setTimeout(r, 300));
				const still = await conversations.get(userId, id);
				expect(still?.status).toBe("idle");
				expect(still?.messages.length).toBe(view?.messages.length);
			});

			it("cancels a call the retried reply made", async () => {
				script({
					parent: [
						fauxAssistantMessage([
							fauxToolCall("slow__crunch", {}),
							fauxToolCall("ask_user", { question: "Which one?" }),
						]),
						fauxAssistantMessage("Again"),
					],
				});
				const id = await conversations.send(userId, {
					agentId: "mcp",
					text: "crunch it",
				});
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && !!v.awaitingReply,
				);
				await conversations.retry(userId, id);
				await waitFor(
					async () => cancels(),
					(c) => c.length === 1,
				);
				const view = await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle",
				);
				expect(view?.backgroundCalls).toEqual([]);
			});

			it("cancels the calls of a deleted Conversation", async () => {
				script({
					parent: [crunch(), fauxAssistantMessage("Crunching")],
				});
				const { id } = await crunched();
				await conversations.delete(userId, id);
				await waitFor(
					async () => cancels(),
					(c) => c.length === 1,
				);
			});

			it("does not cancel the calls of a failed Run: their result still wakes the Conversation", async () => {
				script({
					parent: [
						crunch(),
						() => {
							throw new Error("provider down");
						},
						fauxAssistantMessage("Got it after all"),
					],
				});
				const id = await conversations.send(userId, {
					agentId: "mcp",
					text: "crunch it",
				});
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "failed",
				);
				finishTask("despite the failure");
				const view = await waitFor(
					() => conversations.get(userId, id),
					(v) =>
						v?.status === "idle" &&
						v.messages.at(-1)?.message.role === "assistant",
				);
				expect(view?.backgroundCalls[0].status).toBe("completed");
				expect(cancels()).toEqual([]);
			});

			it(`cancels a call put in the background once the tree's budget of ${MAX_SUBAGENTS_PER_USER_MESSAGE} is spent, until the User writes again`, async () => {
				let refused: unknown;
				let renewed: unknown;
				script({
					parent: [
						fauxAssistantMessage(
							Array.from({ length: MAX_SUBAGENTS_PER_USER_MESSAGE + 1 }, () =>
								fauxToolCall("slow__crunch", {}),
							),
						),
						(context) => {
							refused = context.messages;
							return fauxAssistantMessage("Out of budget");
						},
						crunch(),
						(context) => {
							renewed = context.messages.at(-1);
							return fauxAssistantMessage("Crunching again");
						},
					],
				});
				const id = await conversations.send(userId, {
					agentId: "mcp",
					text: "crunch it all",
				});
				const spent = await waitFor(
					() => conversations.get(userId, id),
					(v) =>
						v?.status === "idle" &&
						v.messages.at(-1)?.message.role === "assistant",
				);
				expect(spent?.backgroundCalls.length).toBe(
					MAX_SUBAGENTS_PER_USER_MESSAGE,
				);
				expect(
					slow.requests.filter((r) => r.method === "tasks/cancel").length,
				).toBe(1);
				expect(JSON.stringify(refused)).toContain(
					`at most ${MAX_SUBAGENTS_PER_USER_MESSAGE} subagents and background calls`,
				);

				await conversations.send(userId, {
					conversationId: id,
					text: "once more",
				});
				const again = await waitFor(
					() => conversations.get(userId, id),
					(v) =>
						v?.status === "idle" &&
						v.messages.at(-1)?.message.role === "assistant" &&
						v.backgroundCalls.length === MAX_SUBAGENTS_PER_USER_MESSAGE + 1,
				);
				expect(again?.backgroundCalls.length).toBe(
					MAX_SUBAGENTS_PER_USER_MESSAGE + 1,
				);
				expect(JSON.stringify(renewed)).toContain("background");
				expect(JSON.stringify(renewed)).not.toContain("at most");
			});

			it("keeps tracking a call across a worker restart", async () => {
				script({
					parent: [
						crunch(),
						fauxAssistantMessage("Crunching"),
						fauxAssistantMessage("Back with it"),
					],
				});
				const id = await conversations.send(userId, {
					agentId: "mcp",
					text: "crunch it",
				});
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && v.messages.length === 4,
				);
				await stopWorker();
				finishTask("after the restart");
				await start();
				const view = await waitFor(
					() => conversations.get(userId, id),
					(v) =>
						v?.status === "idle" &&
						v.messages.at(-1)?.message.role === "assistant" &&
						notifications(v).length === 1,
				);
				expect(JSON.stringify(notifications(view)[0].message)).toContain(
					"after the restart",
				);
			});
		});
	},
);
