import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/config";
import type { ConversationEvent } from "@orqestra/conversations";
import { openToolbox } from "@orqestra/tools";
import { memoryOrrery, memoryStore } from "@orqestra/tools/testing";

// Smoke tests of the assembled worker: the runtime replying through the real @orqestra/conversations
// (lifecycle scenarios are tested there, runtime ones in src/runtime): needs TEST_DATABASE_URL, which src/test-env.ts sets up
const url = process.env.TEST_DATABASE_URL;
const { db } = await import("@orqestra/db");
const { asc, eq, sql } = await import("drizzle-orm");
const { limits, usage } = await import("@orqestra/db/schema");
const { config, skillFiles } = await import("@orqestra/config/live");
const { DEFAULT_LIMITS } = await import("@orqestra/config");
const { createConversations } = await import("@orqestra/conversations");
const { startAgentWorker } = await import("./worker.ts");
const { MAX_SUBAGENT_STEPS } = await import("./runtime/tools.ts");

// one store, as the api and worker share one
const { store } = memoryStore();
const conversations = createConversations({
	store,
	config: config.current,
	skillFiles,
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
	});
	// faux-1 is loaded from the database while a test configures faux as a Provider
	loaded.models.push(
		...faux.models.filter(
			(m) =>
				!loaded.models.some((l) => l.provider === m.provider && l.id === m.id),
		),
	);
	loaded.agents.push(fauxAgent, skilledAgent, smallAgent);
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

		beforeAll(async () => {
			await patch();
			// faux replies are one shared queue, so runs go one at a time
			stopWorker = await startAgentWorker(config.current, {
				concurrency: 1,
				orrery: () => orrery.client,
				store,
				// Search answers with no results
				toolbox: (services, allowed, options) =>
					openToolbox(services, allowed, {
						...options,
						fetch: (async () =>
							new Response(
								JSON.stringify({ results: [] }),
							)) as unknown as typeof fetch,
					}),
			});
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
				sql`truncate conversation, scheduled_task, usage, limits cascade`,
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

			it("fails a Run whose User has used up their limit, sending no request, and a retry once it is raised succeeds", async () => {
				await limitTo(0);
				faux.setResponses([fauxAssistantMessage("Hello")]);
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
				expect(await usageOf(id)).toEqual([]);

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
	},
);
