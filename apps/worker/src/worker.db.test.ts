import {
	afterAll,
	afterEach,
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
	type Context,
	calculateCost,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/agents";
import type { ConversationEvent } from "@orqestra/conversations";
import { memoryStore } from "@orqestra/db/store";
import { memoryOrrery } from "@orqestra/integrations/testing";
import { fakeLinear } from "@orqestra/linear/testing";
import {
	fakeAuthorizationServer,
	fakeMcpServer,
	memoryConnections,
} from "@orqestra/mcp/testing";
import { zip } from "@orqestra/skills/test-zip";
import { createPostgresBackend, Worker } from "bullmq";
import { openToolbox } from "./runtime/toolbox.ts";

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
const {
	limits,
	linearInstallation,
	linearSession,
	pushSubscription,
	usage,
	user,
} = await import("@orqestra/db/schema");
const { encryptSecret } = await import("@orqestra/db/secret");
const { createConversations, DEFAULT_LIMITS, MAX_SUBAGENTS_PER_USER_MESSAGE } =
	await import("@orqestra/conversations");
const { createCapabilities } = await import("./capabilities.ts");
// one store, as the api and worker share one
const { store } = memoryStore();
const config = createCapabilities(db, store);
const { startAgentWorker } = await import("./worker.ts");
const { handleLinearEvent } = await import("./linear.ts");
const { otelTelemetry } = await import("./tracing.ts");
const { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } =
	await import("@opentelemetry/sdk-trace");
// every Run's spans, wiped before every test
const spans = new InMemorySpanExporter();
const telemetry = otelTelemetry(
	new TracerProvider({
		spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
	}).getTracer("test"),
);
const { MAX_SUBAGENT_STEPS } = await import("./runtime/tools.ts");

/** The Users' Connections to per-User OAuth MCP Servers, as the worker reads them. */
const connections = memoryConnections();
const conversations = createConversations({
	store,
	capabilities: {
		current,
		skillFiles: config.skillFiles,
		// the fake MCP Servers are only in the snapshot, so deleting one writes nothing
		mcpServers: { write: async () => [] as never },
		agents: { forget: async () => {} },
	},
	fetch: (input, init) => fetchFake(input, init),
	connections,
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
	default: false,
	pickable: true,
	tools: ["search", "scrape"],
	skills: [],
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
	tools: [],
};
// an Agent that may use the MCP Server `slow`, whose `crunch` it puts in the background
const mcpAgent: AgentDefinition = {
	...fauxAgent,
	id: "mcp",
	tools: ["search", "mcp:slow"],
};
// a template whose Subagents may use it too
const mcpSubAgent: AgentDefinition = {
	...mcpAgent,
	id: "mcp-sub",
	instructions: "You carry out one task with a slow service.",
	pickable: false,
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
/** When set, `slow` is behind this authorization server, which answers at as.example.com. */
let as: ReturnType<typeof fakeAuthorizationServer> | undefined;
/** Linear, which the app posts its Agent Sessions' activities to. */
let linear = fakeLinear();
const fetchFake = (async (input: string | URL, init?: RequestInit) => {
	const host = new URL(String(input)).hostname;
	if (host === "api.linear.app") return linear.fetch(input, init);
	if (host === "slow.example.com")
		return as ? as.guard(slow.fetch)(input, init) : slow.fetch(input, init);
	if (as && host === "as.example.com") return as.fetch(input, init);
	return new Response(JSON.stringify({ results: [] }));
}) as typeof fetch;
const userId = "u1";
/** When set as a Run opens its Tools, closing them throws, after its reply. */
let closeFails = false;
// a command that runs until it is canceled, one that writes a report, and the check attach makes
const orrery = memoryOrrery({
	exec: (command, files) => {
		// a Subagent's command comes after the cd into its own folder
		if (command.endsWith("sleep 1000")) return { running: true };
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

/**
 * The loaded config with the test's faux Provider, Agents, Sandbox and Tools added, again to each snapshot a reload makes:
 * a write's own NOTIFY may reload it once more after the write has returned.
 */
type Loaded = Awaited<ReturnType<typeof config.current>>;
const patched = new WeakSet<Loaded>();
async function current(): Promise<Loaded> {
	const loaded = await config.current();
	if (!patched.has(loaded)) {
		patched.add(loaded);
		patch(loaded);
	}
	return loaded;
}
function patch(loaded: Loaded) {
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
	// a reload of another capability keeps the Agents
	loaded.agents.push(
		...[fauxAgent, skilledAgent, smallAgent, mcpAgent, mcpSubAgent].filter(
			(a) => !loaded.agents.some((l) => l.id === a.id),
		),
	);
	loaded.mcpServers.slow = {
		name: "Slow",
		url: "https://slow.example.com/mcp",
		headers: {},
	};
	loaded.allMcpServers.slow = loaded.mcpServers.slow;
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
		const start = async ({
			stalledInterval,
		}: {
			stalledInterval?: number;
		} = {}) => {
			// faux replies are one shared queue, so runs go one at a time
			stopWorker = await startAgentWorker(
				{ ...config, current },
				{
					concurrency: 1,
					stalledInterval,
					orrery: () => orrery.client,
					store,
					toolbox: async (services, allowed, options) => {
						// a Run still being titled from the test before closes its own Tools fine
						const fails = closeFails;
						const box = await openToolbox(services, allowed, {
							...options,
							fetch: fetchFake,
						});
						return {
							...box,
							close: async () => {
								await box.close();
								if (fails) throw new Error("could not close the Tools");
							},
						};
					},
					fetch: fetchFake,
					connections,
					telemetry,
				},
			);
		};

		afterAll(async () => {
			await stopWorker?.();
			await config.close();
		});

		beforeEach(async () => {
			// Subagents may outlive a test: stop them so they neither linger nor hold up stopping the worker
			await db.execute(
				sql`select pg_notify('conversation_stop', id::text) from conversation where status = 'running'`,
			);
			// a Run the last test left winding down would deadlock with the truncate: stopping the worker waits for it
			await stopWorker?.();
			await db.execute(
				sql`truncate conversation, scheduled_task, usage, limits, push_subscription, "user", linear_installation cascade`,
			);
			spans.reset();
			await start();
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

		it("ends a Run without waiting for its title: the worker's one slot takes the next Run while the title is slow, and the title comes once it answers, metered", async () => {
			let release!: () => void;
			const slow = new Promise<void>((r) => {
				release = r;
			});
			faux.setResponses(
				Array.from({ length: 4 }, () => async (context: Context) => {
					const asked = JSON.stringify(context.messages);
					if (!asked.includes("Write a title"))
						return fauxAssistantMessage(
							asked.includes("second") ? "Reply two" : "Reply one",
						);
					if (!asked.includes("User: first"))
						return fauxAssistantMessage("Second title");
					await slow;
					return fauxAssistantMessage("First title");
				}),
			);
			try {
				const first = await conversations.send(userId, {
					agentId: "faux",
					text: "first",
				});
				await waitFor(
					() => conversations.get(userId, first),
					(v) => v?.status === "idle",
				);
				// concurrency 1: this Run starts only once the first Run's job has completed
				const second = await conversations.send(userId, {
					agentId: "faux",
					text: "second",
				});
				await waitFor(
					() => conversations.get(userId, second),
					(v) => v?.title === "Second title",
				);
				expect((await conversations.get(userId, first))?.title).toBeNull();

				release();
				await waitFor(
					() => conversations.get(userId, first),
					(v) => v?.title === "First title",
				);
				const rows = await waitFor(
					() => usageOf(first),
					(r) => r.length === 2,
				);
				expect(rows.map((r) => r.purpose).sort()).toEqual(["step", "title"]);
			} finally {
				release();
			}
		});

		it("leaves a Run completed when its title fails, and titles the Conversation on its next Turn", async () => {
			let titles = 0;
			faux.setResponses(
				Array.from({ length: 4 }, () => async (context: Context) => {
					if (!JSON.stringify(context.messages[0]).includes("Write a title"))
						return fauxAssistantMessage("Hello");
					if (++titles === 1) throw new Error("connection refused");
					return fauxAssistantMessage("Greetings");
				}),
			);
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "hi",
			});
			await waitFor(
				async () => titles,
				(n) => n === 1,
			);
			const view = await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.status === "idle",
			);
			expect(view?.failure).toBeNull();
			expect(view?.title).toBeNull();
			expect(view?.messages.map((m) => m.message.role)).toEqual([
				"user",
				"assistant",
			]);

			await conversations.send(userId, { conversationId: id, text: "again" });
			const titled = await waitFor(
				() => conversations.get(userId, id),
				(v) => !!v?.title,
			);
			expect(titled?.title).toBe("Greetings");
			expect(titled?.status).toBe("idle");
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

		it("traces a Subagent's first Run under the Tool call that started it, and the Run its Notification wakes as a root linked back to it", async () => {
			script({
				parent: [
					fauxAssistantMessage(
						fauxToolCall("subagent", { tasks: [{ brief: "dig" }] }),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("Digging"),
					fauxAssistantMessage("Done"),
				],
				sub: [
					// once the parent's Run is over, so the Notification wakes another
					async () => {
						await waitFor(
							async () => spans.getFinishedSpans(),
							(all) =>
								all.some(
									(s) =>
										s.name === "invoke_agent" &&
										s.attributes["gen_ai.conversation.id"] === id,
								),
						);
						return fauxAssistantMessage("what I found");
					},
				],
			});
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "dig deep",
			});
			const runs = await waitFor(
				async () =>
					spans.getFinishedSpans().filter((s) => s.name === "invoke_agent"),
				(r) => r.length === 3,
			);
			const [tool] = spans
				.getFinishedSpans()
				.filter((s) => s.name === "execute_tool subagent");
			const [first, woken] = runs.filter(
				(r) => r.attributes["gen_ai.conversation.id"] === id,
			);
			const sub = runs.find(
				(r) => r.attributes["gen_ai.conversation.id"] !== id,
			);

			expect(first?.parentSpanContext).toBeUndefined();
			expect(tool?.parentSpanContext?.spanId).toBe(
				first?.spanContext().spanId as string,
			);
			expect(sub?.spanContext().traceId).toBe(
				first?.spanContext().traceId as string,
			);
			expect(sub?.parentSpanContext?.spanId).toBe(
				tool?.spanContext().spanId as string,
			);
			expect(woken?.parentSpanContext).toBeUndefined();
			expect(woken?.spanContext().traceId).not.toBe(
				first?.spanContext().traceId as string,
			);
			expect(woken?.links.map((l) => l.context.spanId)).toEqual([
				tool?.spanContext().spanId as string,
			]);
			// a User's message links to nothing
			expect(first?.links).toEqual([]);
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
			const execs = await waitFor(
				() => calls("createExec"),
				(c) => c.some((x) => x.endsWith(" sleep 1000")),
			);
			// in its own folder of the shared Sandbox
			expect(execs?.find((x) => x.endsWith(" sleep 1000"))).toContain(
				"cd '/workspace/subagents/",
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

		it("copies a Skill's files from object storage into the Sandbox, byte for byte", async () => {
			const md =
				"---\nname: notes\ndescription: Takes notes\n---\nWrite them down.\n";
			const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
			await config.skills.upload(
				zip([
					{ path: "notes/SKILL.md", content: md },
					{ path: "notes/assets/logo.png", content: png },
				]),
				false,
			);
			const [{ currentVersionId }] = await config.skills.list();
			// the uploaded version, for the skilled template's Subagent
			(await current()).skills.notes.versionId = currentVersionId ?? 0;
			try {
				script({
					parent: [
						fauxAssistantMessage(
							fauxToolCall("subagent", {
								tasks: [{ brief: "note", template: "skilled" }],
							}),
						),
						fauxAssistantMessage("Waiting"),
						fauxAssistantMessage("Done"),
					],
					sub: [
						fauxAssistantMessage(fauxToolCall("bash", { command: "ls" })),
						fauxAssistantMessage("noted"),
					],
				});
				const id = await conversations.send(userId, {
					agentId: "faux",
					text: "take notes",
				});
				await waitFor(
					() => conversations.get(userId, id),
					(v) =>
						v?.status === "idle" &&
						v.messages.at(-1)?.message.role === "assistant" &&
						v.messages.some((m) => m.subagentId),
				);
				const {
					rows: [row],
				} = await db.execute<{ sandbox_id: string }>(
					sql`select sandbox_id from conversation where id = ${id}`,
				);
				const files = orrery.files(row.sandbox_id);
				expect(Buffer.from(files.get(".skills/notes/SKILL.md") ?? [])).toEqual(
					Buffer.from(md),
				);
				expect(
					Buffer.from(files.get(".skills/notes/assets/logo.png") ?? []),
				).toEqual(png);
			} finally {
				await config.skills.delete("notes");
			}
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
			await config.models.providers.save({
				id: "faux",
				apiKey: "k",
				baseUrl: model.baseUrl,
			});
			await config.models.providers.setModelEnabled({
				providerId: "faux",
				modelId: "faux-1",
				enabled: true,
			});
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
				await config.models.providers.setModelPrice({
					providerId: "faux",
					modelId: "faux-1",
					cost,
				});
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
				await config.models.providers.delete("faux");
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
			// small budgets on faux-small's tiny context window, so the second Turn compacts
			const loaded = await current();
			const saved = loaded.limits;
			loaded.limits = {
				...saved,
				compactionReserveTokens: 1000,
				compactionKeepRecentTokens: 50,
			};
			try {
				const id = await conversations.send(userId, {
					agentId: "small",
					model: "faux/faux-small",
					text: "word ".repeat(1500),
				});
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && !!v.title,
				);
				// long enough to be kept, so the first Turn is what gets summarized
				await conversations.send(userId, {
					conversationId: id,
					model: "faux/faux-small",
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
				// the title is the default Model's
				expect(
					rows
						.filter((r) => r.purpose !== "title")
						.every((r) => r.modelId === "faux-small"),
				).toBe(true);
			} finally {
				loaded.limits = saved;
			}
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

		describe("a Linear Agent Session's Conversation", () => {
			beforeEach(async () => {
				linear = fakeLinear();
				linear.accessTokens.add("access-0");
				await db.insert(linearInstallation).values({
					clientId: "lin-client",
					clientSecret: encryptSecret(linear.clientSecret),
					webhookSecret: encryptSecret("hook-s3cret"),
					tokens: encryptSecret(
						JSON.stringify({
							accessToken: "access-0",
							refreshToken: "refresh-0",
							expiresAt: Date.now() + 3_600_000,
						}),
					),
					workspace: "Acme",
					teamRepos: {},
				});
			});
			/** Sends a message from the session, as the worker does for Linear's events: the first opens its Conversation. */
			const fromLinear = (text: string, conversationId?: string) =>
				conversations.send(userId, {
					...(conversationId
						? { conversationId }
						: { agentId: "faux", linearSessionId: "session-1" }),
					text,
					origin: "linear",
				});
			/** The session's activities once there are `n`, and still `n` a moment later: no other one follows. */
			const posted = async (n: number) => {
				await waitFor(
					async () => linear.activities,
					(a) => a.length >= n,
				);
				await new Promise((r) => setTimeout(r, 300));
				expect(linear.activities).toHaveLength(n);
				return linear.activities;
			};

			it("posts each Run's last reply into the session as its response", async () => {
				script({
					parent: [
						fauxAssistantMessage(
							fauxToolCall("bash", { command: "make report" }),
						),
						fauxAssistantMessage(
							"Opened https://github.com/acme/web/pull/1 with the fix.",
						),
						fauxAssistantMessage("Firefox works too."),
					],
				});
				const id = await fromLinear("Fix the login button");
				expect(await posted(1)).toEqual([
					{
						agentSessionId: "session-1",
						content: {
							type: "response",
							body: "Opened https://github.com/acme/web/pull/1 with the fix.",
						},
					},
				]);

				await fromLinear("Also check Firefox.", id);
				expect((await posted(2))[1].content).toEqual({
					type: "response",
					body: "Firefox works too.",
				});
			});

			it("posts one response for a Run that took a message sent meanwhile, its reply to that", async () => {
				let begun!: () => void;
				const replying = new Promise<void>((r) => {
					begun = r;
				});
				let release!: () => void;
				const held = new Promise<void>((r) => {
					release = r;
				});
				faux.setResponses([
					async () => {
						begun();
						await held;
						return fauxAssistantMessage("Looking.");
					},
					fauxAssistantMessage("Both fixed."),
					fauxAssistantMessage("T"),
				]);
				const id = await fromLinear("Fix the login button");
				await replying;
				try {
					await fromLinear("Also check Firefox.", id);
				} finally {
					release();
				}
				expect(await posted(1)).toEqual([
					{
						agentSessionId: "session-1",
						content: { type: "response", body: "Both fixed." },
					},
				]);
			});

			it("closes the turn before the Conversation is titled", async () => {
				let release!: () => void;
				const titling = new Promise<void>((r) => {
					release = r;
				});
				faux.setResponses([
					fauxAssistantMessage("Done."),
					async () => {
						await titling;
						return fauxAssistantMessage("T");
					},
				]);
				const id = await fromLinear("Fix the login button");
				try {
					expect(await posted(1)).toEqual([
						{
							agentSessionId: "session-1",
							content: { type: "response", body: "Done." },
						},
					]);
					expect((await conversations.get(userId, id))?.title).toBeNull();
				} finally {
					release();
				}
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.title === "T",
				);
				expect(await posted(1)).toHaveLength(1);
			});

			it("posts a Run that failed as an error", async () => {
				faux.setResponses([
					() => {
						throw new Error("connection refused");
					},
				]);
				await fromLinear("Fix the login button");
				expect(await posted(1)).toEqual([
					{
						agentSessionId: "session-1",
						content: {
							type: "error",
							body: "This reply failed. Retry it in Orqestra.",
						},
					},
				]);
			});

			it("posts a Run that failed before its reply began, its Agent removed, as one error", async () => {
				await stopWorker();
				const loaded = await config.current();
				const agents = loaded.agents;
				try {
					const id = await fromLinear("Fix the login button");
					loaded.agents = agents.filter((a) => a.id !== "faux");
					await start();
					await waitFor(
						() => conversations.get(userId, id),
						(v) => v?.status === "failed",
					);
					expect(await posted(1)).toEqual([
						{
							agentSessionId: "session-1",
							content: {
								type: "error",
								body: "This reply failed. Retry it in Orqestra.",
							},
						},
					]);
				} finally {
					loaded.agents = agents;
				}
			}, 15_000);

			it("posts a Run whose worker was killed as one error once another worker notices", async () => {
				await stopWorker();
				let picked = false;
				// a worker that takes the Run and dies without finishing it
				const killed = new Worker(
					"agent-runs",
					() => {
						picked = true;
						return new Promise(() => {});
					},
					{
						connection: { connectionString: url as string },
						lockDuration: 300,
					},
					createPostgresBackend,
				);
				const id = await fromLinear("Fix the login button");
				await waitFor(async () => picked, Boolean);
				await killed.close(true);
				// the startup requeue finds it running and queues no second job for it
				await start({ stalledInterval: 200 });
				try {
					await waitFor(
						() => conversations.get(userId, id),
						(v) => v?.status === "failed",
					);
					expect(await posted(1)).toEqual([
						{
							agentSessionId: "session-1",
							content: {
								type: "error",
								body: "This reply failed. Retry it in Orqestra.",
							},
						},
					]);
				} finally {
					await stopWorker();
					await start();
				}
			}, 15_000);

			it("posts a Question the Run ended with as an elicitation", async () => {
				script({
					parent: [
						fauxAssistantMessage([
							fauxText("Two buttons say log in."),
							fauxToolCall("ask_user", {
								question: "Which one?",
								suggestions: ["Header", "Footer"],
							}),
						]),
					],
				});
				await fromLinear("Fix the login button");
				expect(await posted(1)).toEqual([
					{
						agentSessionId: "session-1",
						content: {
							type: "elicitation",
							body: "Two buttons say log in.\n\nWhich one?\n\n- Header\n- Footer",
						},
					},
				]);
			});

			it("posts nothing for a Run the User stopped", async () => {
				script({
					parent: [
						fauxAssistantMessage([
							fauxText("Looking into it."),
							fauxToolCall("bash", { command: "sleep 1000" }),
						]),
						fauxAssistantMessage("Picked up again."),
					],
				});
				const earlier = orrery.calls.length;
				const id = await fromLinear("Fix the login button");
				await waitFor(
					async () => orrery.calls.slice(earlier),
					(c) => c.some((x) => x.endsWith(" sleep 1000")),
				);
				await conversations.stop(userId, id);
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle",
				);
				// Runs go one at a time: the next one's reply comes after the stopped one has posted whatever it would
				await fromLinear("Go on.", id);
				expect(await posted(1)).toEqual([
					{
						agentSessionId: "session-1",
						content: { type: "response", body: "Picked up again." },
					},
				]);
			});

			it("closes the turn once when Linear stops a Run its start then could not queue: with the stop's confirmation, and no error after it", async () => {
				// the queue's add waits on a lock the test holds, then fails, as when the queue's database goes away mid-add
				const held = await db.$client.connect();
				await held.query("select pg_advisory_lock(4242)");
				await db.execute(
					sql.raw(
						"create function bullmq.add_fails() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(4242); raise exception 'queue down'; end $$",
					),
				);
				await db.execute(
					sql.raw(
						"create trigger add_fails before insert on bullmq.job for each row when (new.queue = 'agent-runs') execute function bullmq.add_fails()",
					),
				);
				try {
					const sent = fromLinear("Fix the login button");
					const [session] = await waitFor(
						() => db.select().from(linearSession),
						(s) => s.length > 0,
					);
					await handleLinearEvent(
						{
							id: "stop-1",
							agentSessionId: "session-1",
							action: "prompted",
							from: null,
							issue: null,
							text: "Stop",
							stop: true,
						},
						conversations,
						{ fetch: fetchFake },
					);
					await held.query("select pg_advisory_unlock(4242)");
					await expect(sent).rejects.toThrow("queue down");
					await waitFor(
						() => conversations.get(userId, session.conversationId),
						(v) => v?.status === "failed",
					);
					expect(await posted(1)).toEqual([
						{
							agentSessionId: "session-1",
							content: { type: "response", body: "Stopped." },
						},
					]);
				} finally {
					await held.query("select pg_advisory_unlock_all()");
					held.release();
					await db.execute(
						sql.raw(
							"drop trigger if exists add_fails on bullmq.job; drop function if exists bullmq.add_fails()",
						),
					);
				}
			});

			it("posts a Run that found nothing to report as a response saying so, not what it said on its way", async () => {
				script({
					parent: [
						fauxAssistantMessage([
							fauxText("Let me look."),
							fauxToolCall("bash", { command: "make report" }),
						]),
						fauxAssistantMessage(
							fauxToolCall("nothing_to_report", {
								reason: "The button already works.",
							}),
						),
					],
				});
				await fromLinear("Fix the login button");
				expect(await posted(1)).toEqual([
					{
						agentSessionId: "session-1",
						content: {
							type: "response",
							body: "Nothing to report: The button already works.",
						},
					},
				]);
			});

			it("posts a Run that said nothing as a response saying there was nothing to report", async () => {
				script({
					parent: [fauxAssistantMessage([fauxThinking("Nothing to add.")])],
				});
				await fromLinear("Fix the login button");
				expect(await posted(1)).toEqual([
					{
						agentSessionId: "session-1",
						content: { type: "response", body: "Nothing to report." },
					},
				]);
			});

			describe("out of time", () => {
				// the shortest limit, a second, against replies faux takes seconds to stream
				let was = DEFAULT_LIMITS;
				beforeEach(async () => {
					const loaded = await config.current();
					was = loaded.limits;
					loaded.limits = { ...was, unattendedMaxDuration: 1 };
				});
				afterEach(async () => {
					(await config.current()).limits = was;
				});
				const cutOff =
					"Partly done: this ran out of time and stopped before it finished. Reply here to carry on.";

				it("posts a Run cut off while thinking as an error", async () => {
					script({
						parent: [
							fauxAssistantMessage([
								fauxThinking("hmm ".repeat(4000)),
								fauxText("Done."),
							]),
						],
					});
					await fromLinear("Fix the login button");
					expect(await posted(1)).toEqual([
						{
							agentSessionId: "session-1",
							content: { type: "error", body: cutOff },
						},
					]);
				});

				it("posts a reply cut off as an error, with what it had written", async () => {
					const full = "word ".repeat(4000).trim();
					script({ parent: [fauxAssistantMessage(full)] });
					await fromLinear("Fix the login button");
					const [activity, ...more] = await posted(1);
					expect(more).toEqual([]);
					expect(activity.content.type).toBe("error");
					const [head, written] = activity.content.body.split(
						"\n\nWhat it had written when it stopped:\n\n",
					);
					expect(head).toBe(cutOff);
					expect(full.startsWith(written)).toBe(true);
					expect(written.length).toBeLessThan(full.length);
				});

				it("posts a Run out of time before its reply began as an error", async () => {
					// its MCP Server still connecting when the limit passes
					const real = newSlow();
					slow = {
						...real,
						fetch: async (input, init) => {
							await new Promise((r) => setTimeout(r, 1500));
							return real.fetch(input, init);
						},
					};
					try {
						await conversations.send(userId, {
							agentId: "mcp",
							linearSessionId: "session-1",
							text: "Fix the login button",
							origin: "linear",
						});
						expect(await posted(1)).toEqual([
							{
								agentSessionId: "session-1",
								content: { type: "error", body: cutOff },
							},
						]);
					} finally {
						slow = newSlow();
					}
				});

				it("posts the reply of a Run that ended in time, though the limit passed while it was titled", async () => {
					faux.setResponses([
						fauxAssistantMessage("Done."),
						async () => {
							await new Promise((r) => setTimeout(r, 1500));
							return fauxAssistantMessage("T");
						},
					]);
					await fromLinear("Fix the login button");
					expect(await posted(1)).toEqual([
						{
							agentSessionId: "session-1",
							content: { type: "response", body: "Done." },
						},
					]);
				});

				it("posts only the reply of a Run that ended in time, though the limit passed while it was titled and its Tools then failed to close", async () => {
					closeFails = true;
					try {
						faux.setResponses([
							fauxAssistantMessage("Done."),
							async () => {
								await new Promise((r) => setTimeout(r, 1500));
								return fauxAssistantMessage("T");
							},
						]);
						const id = await fromLinear("Fix the login button");
						await waitFor(
							() => conversations.get(userId, id),
							(v) => v?.title === "T",
						);
						expect(await posted(1)).toEqual([
							{
								agentSessionId: "session-1",
								content: { type: "response", body: "Done." },
							},
						]);
						expect((await conversations.get(userId, id))?.status).toBe("idle");
					} finally {
						closeFails = false;
					}
				});
			});

			it("posts nothing for a Conversation of no Agent Session", async () => {
				script({ parent: [fauxAssistantMessage("Hello")] });
				const id = await conversations.send(userId, {
					agentId: "faux",
					text: "hi",
				});
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.title === "T",
				);
				faux.setResponses([
					() => {
						throw new Error("connection refused");
					},
				]);
				await conversations.send(userId, { conversationId: id, text: "again" });
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "failed",
				);
				expect(linear.activities).toEqual([]);
			});
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

			it("traces the Run its result wakes as a root linked back to the Tool call that made it", async () => {
				script({
					parent: [
						crunch(),
						fauxAssistantMessage("Crunching"),
						fauxAssistantMessage("Done"),
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
				finishTask("42");
				const [first, woken] = await waitFor(
					async () =>
						spans.getFinishedSpans().filter((s) => s.name === "invoke_agent"),
					(r) => r.length === 2,
				);
				const [tool] = spans
					.getFinishedSpans()
					.filter((s) => s.name === "execute_tool slow__crunch");

				expect(tool?.parentSpanContext?.spanId).toBe(
					first?.spanContext().spanId as string,
				);
				expect(woken?.parentSpanContext).toBeUndefined();
				expect(woken?.spanContext().traceId).not.toBe(
					first?.spanContext().traceId as string,
				);
				expect(woken?.links.map((l) => l.context.spanId)).toEqual([
					tool?.spanContext().spanId as string,
				]);
			});

			it("hands the Agent a result's images as an immediate result would", async () => {
				let woken: unknown;
				script({
					parent: [
						crunch(),
						fauxAssistantMessage("Crunching"),
						(context) => {
							woken = context.messages.at(-1);
							return fauxAssistantMessage("A chart");
						},
					],
				});
				const id = await conversations.send(userId, {
					agentId: "mcp",
					text: "chart it",
				});
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.status === "idle" && v.messages.length === 4,
				);
				Object.assign(slow.tasks.get("task-1") ?? {}, {
					status: "completed",
					result: {
						content: [
							{ type: "text", text: "the chart" },
							{ type: "image", data: "iVBORw0K", mimeType: "image/png" },
						],
					},
				});
				await waitFor(
					() => conversations.get(userId, id),
					(v) => v?.messages.at(-1)?.message.role === "assistant" && !!woken,
				);
				expect(woken).toMatchObject({
					role: "user",
					content: [
						{ type: "text", text: expect.stringContaining("the chart") },
						{ type: "image", data: "iVBORw0K", mimeType: "image/png" },
					],
				});
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

			it("tells a Firing what the one before reported, and lets it end quietly, without Unread or an Alert", async () => {
				await alerted();
				script({ parent: [fauxAssistantMessage("News A")] });
				const taskId = await conversations.tasks.create(userId, input());
				const firings = async () =>
					(await conversations.tasks.get(userId, taskId))?.firings ?? [];
				await waitFor(firings, (f) => f[0]?.outcome === "completed");
				await waitFor(runAlerts, (p) => p.length === 1);

				let prompt = "";
				script({
					parent: [
						(context) => {
							prompt = JSON.stringify(context.messages);
							return fauxAssistantMessage(
								fauxToolCall("nothing_to_report", { reason: "no news" }),
							);
						},
					],
				});
				await conversations.tasks.update(userId, taskId, input());
				const [second] = await waitFor(
					firings,
					(f) => f.length === 2 && f[0].outcome === "completed",
				);
				expect(prompt).toContain(
					JSON.stringify("<previous_report>\nNews A\n</previous_report>").slice(
						1,
						-1,
					),
				);
				const view = await conversations.get(
					userId,
					second.conversationId as string,
				);
				expect(view?.unread).toBe(false);
				await new Promise((r) => setTimeout(r, 300));
				expect(await runAlerts()).toHaveLength(1);
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

			describe("of a Subagent", () => {
				const delegate = (template = "mcp-sub") =>
					fauxAssistantMessage(
						fauxToolCall("subagent", {
							tasks: [{ brief: "crunch", template }],
						}),
					);
				/** The parent delegates to a Subagent, which puts a call in the background and ends its Run. */
				const delegated = async (parentAfter: FauxResponseStep[] = []) => {
					script({
						parent: [
							delegate(),
							fauxAssistantMessage("Delegated"),
							...parentAfter,
						],
						sub: [
							crunch(),
							fauxAssistantMessage("Crunching"),
							fauxAssistantMessage("The answer is 42"),
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
							v.messages.length === 4 &&
							v.backgroundCalls.length === 1,
					);
					const subId = view?.subagents[0].id as string;
					// its Run has ended: it waits for its call idle, holding no slot
					await waitFor(
						() =>
							db.execute(
								sql`select status from conversation where id = ${subId}`,
							),
						(r) => r.rows[0]?.status === "idle",
					);
					return {
						id,
						subId,
						toolCallId: view?.backgroundCalls[0].toolCallId ?? "",
					};
				};

				it("is not done while its call runs, and its Notification reaches the parent once the call ends", async () => {
					let woken: unknown;
					const { id } = await delegated([
						(context) => {
							woken = context.messages;
							return fauxAssistantMessage("Done");
						},
					]);
					await new Promise((r) => setTimeout(r, 300));
					const waiting = await conversations.get(userId, id);
					expect(waiting?.subagents[0].outcome).toBe("running");
					expect(waiting?.messages.length).toBe(4);
					expect(waiting?.status).toBe("idle");

					finishTask("42 it is");
					const done = await waitFor(
						() => conversations.get(userId, id),
						(v) =>
							v?.status === "idle" &&
							v.messages.at(-1)?.message.role === "assistant" &&
							v.messages.length === 6,
					);
					expect(done?.subagents[0].outcome).toBe("completed");
					expect(done?.backgroundCalls[0].status).toBe("completed");
					expect(JSON.stringify(woken)).toContain("The answer is 42");
				});

				it("cancels its calls when the Agent stops it, and it settles at once", async () => {
					const { id } = await delegated([
						fauxAssistantMessage(
							fauxToolCall("subagent_stop", { numbers: [1] }),
						),
						fauxAssistantMessage("Stopped it"),
					]);
					await conversations.send(userId, {
						conversationId: id,
						text: "stop it",
					});
					await waitFor(
						async () => cancels(),
						(c) => c.length === 1,
					);
					const view = await waitFor(
						() => conversations.get(userId, id),
						(v) =>
							v?.status === "idle" &&
							v.messages.at(-1)?.message.role === "assistant" &&
							v.subagents[0].outcome === "stopped",
					);
					expect(view?.backgroundCalls[0].status).toBe("cancelled");
				});

				it("cancels its calls when the User stops it, and it settles at once", async () => {
					const { id, subId } = await delegated();
					expect(await conversations.stopSubagent(userId, subId)).toBe(true);
					await waitFor(
						async () => cancels(),
						(c) => c.length === 1,
					);
					const view = await waitFor(
						() => conversations.get(userId, id),
						(v) => v?.subagents[0].outcome === "stopped",
					);
					expect(view?.backgroundCalls[0].status).toBe("cancelled");
					// its Notification, left for whoever continues it
					const { rows } = await db.execute(
						sql`select message from inbox where conversation_id = ${subId} and background_call_id is not null`,
					);
					expect(JSON.stringify(rows)).toContain("the Subagent was stopped");
				});

				it("keeps a Firing running, with no Alert, while its Subagent is unfinished, and ends it once the Subagent has", async () => {
					await alerted();
					script({
						parent: [
							delegate(),
							fauxAssistantMessage("Delegated"),
							fauxAssistantMessage("Done"),
						],
						sub: [
							crunch(),
							fauxAssistantMessage("Crunching"),
							fauxAssistantMessage("The answer is 42"),
						],
					});
					const taskId = await conversations.tasks.create(userId, input());
					const firing = async () =>
						(await conversations.tasks.get(userId, taskId))?.firings[0];
					const started = await waitFor(firing, (f) => !!f?.conversationId);
					const id = started?.conversationId as string;
					await waitFor(
						() => conversations.get(userId, id),
						(v) =>
							v?.status === "idle" &&
							v.messages.length === 4 &&
							v.backgroundCalls.length === 1,
					);
					await new Promise((r) => setTimeout(r, 300));
					expect(
						(await conversations.get(userId, id))?.subagents[0].outcome,
					).toBe("running");
					expect((await firing())?.outcome).toBe("running");
					expect(await runAlerts()).toEqual([]);

					finishTask("42 it is");
					await waitFor(firing, (f) => f?.outcome === "completed");
					const [alert] = await waitFor(runAlerts, (p) => p.length === 1);
					expect(alert).toMatchObject({ status: "completed", url: `/c/${id}` });
				});

				it("is not done when its Run fails while its call runs, and settles once a later Run ends", async () => {
					script({
						parent: [
							delegate(),
							fauxAssistantMessage("Delegated"),
							fauxAssistantMessage("Done"),
						],
						sub: [
							crunch(),
							() => {
								throw new Error("provider down");
							},
							fauxAssistantMessage("The answer is 42"),
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
							v.messages.length === 4 &&
							v.backgroundCalls.length === 1,
					);
					const subId = view?.subagents[0].id as string;
					await waitFor(
						() =>
							db.execute(
								sql`select status from conversation where id = ${subId}`,
							),
						(r) => r.rows[0]?.status === "idle",
					);
					await new Promise((r) => setTimeout(r, 300));
					const waiting = await conversations.get(userId, id);
					expect(waiting?.subagents[0].outcome).toBe("running");
					expect(waiting?.messages.length).toBe(4);

					finishTask("42 it is");
					const done = await waitFor(
						() => conversations.get(userId, id),
						(v) =>
							v?.status === "idle" &&
							v.messages.at(-1)?.message.role === "assistant" &&
							v.messages.length === 6,
					);
					expect(done?.subagents[0].outcome).toBe("completed");
					await new Promise((r) => setTimeout(r, 300));
					const after = await conversations.get(userId, id);
					expect(after?.messages.filter((m) => m.subagentId)).toHaveLength(1);
				});

				/** A Firing whose Run delegated to a Subagent, that `sub` scripts, and ended; returns once the Subagent is busy. */
				const delegatedFiring = async (
					sub: FauxResponseStep[],
					busy: (subId: string) => Promise<boolean>,
					template?: string,
				) => {
					await alerted();
					script({
						parent: [delegate(template), fauxAssistantMessage("Delegated")],
						sub,
					});
					const taskId = await conversations.tasks.create(userId, input());
					const firing = async () =>
						(await conversations.tasks.get(userId, taskId))?.firings[0];
					const started = await waitFor(firing, (f) => !!f?.conversationId);
					const id = started?.conversationId as string;
					const view = await waitFor(
						() => conversations.get(userId, id),
						(v) => v?.status === "idle" && v.messages.length === 4,
					);
					const subId = view?.subagents[0].id as string;
					await waitFor(
						() => busy(subId),
						(b) => b,
					);
					expect((await firing())?.outcome).toBe("running");
					return { id, subId, firing };
				};

				it("ends a Firing as its root's Run did, with its Alert, once the User stops the Subagent it waited for", async () => {
					const { id, subId, firing } = await delegatedFiring(
						[crunch(), fauxAssistantMessage("Crunching")],
						async (subId) =>
							(
								await db.execute(
									sql`select 1 from conversation c join background_call b on b.conversation_id = c.id where c.id = ${subId} and c.status = 'idle'`,
								)
							).rows.length > 0,
					);
					await conversations.stopSubagent(userId, subId);
					await waitFor(firing, (f) => f?.outcome === "completed");
					const [alert] = await waitFor(runAlerts, (p) => p.length === 1);
					expect(alert).toMatchObject({ status: "completed", url: `/c/${id}` });
				});

				it("ends a Firing, with its Alert, once the User stops its Subagent that had no Background Call", async () => {
					const execs = orrery.calls.length;
					const { subId, firing } = await delegatedFiring(
						[
							fauxAssistantMessage(
								fauxToolCall("bash", { command: "sleep 1000" }),
							),
						],
						async () =>
							orrery.calls.slice(execs).some((c) => c.endsWith(" sleep 1000")),
						"skilled",
					);
					await conversations.stopSubagent(userId, subId);
					await waitFor(firing, (f) => f?.outcome === "completed");
					await waitFor(runAlerts, (p) => p.length === 1);
				});

				it("lets the User cancel its call through the top-level Conversation", async () => {
					const { id, toolCallId } = await delegated([
						fauxAssistantMessage("Done"),
					]);
					expect(
						await conversations.cancelBackgroundCall(userId, id, toolCallId),
					).toBe(true);
					await waitFor(
						async () => cancels(),
						(c) => c.length === 1,
					);
					const view = await conversations.get(userId, id);
					expect(view?.backgroundCalls[0].status).toBe("cancelled");
					// it waited for nothing else: it sums up and settles
					await waitFor(
						() => conversations.get(userId, id),
						(v) => v?.subagents[0].outcome === "completed",
					);
				});
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

			describe("ends", () => {
				const cancels = () =>
					slow.requests.filter((r) => r.method === "tasks/cancel").length;
				const task = () => slow.tasks.get("task-1") ?? { status: "working" };
				/** Starts a Background Call and waits until the Run that made it has ended. */
				const backgrounded = async () => {
					script({
						parent: [
							crunch(),
							fauxAssistantMessage("Crunching"),
							fauxAssistantMessage("Told"),
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
					return id;
				};
				/** Waits for the Notification and the reply it woke; returns the Notification's text. */
				const woken = async (
					id: string,
					status: "completed" | "failed" | "cancelled",
				) => {
					const view = await waitFor(
						() => conversations.get(userId, id),
						(v) =>
							v?.status === "idle" &&
							v.messages.at(-1)?.message.role === "assistant" &&
							notifications(v).length === 1,
					);
					expect(view?.backgroundCalls[0].status).toBe(status);
					const frame = JSON.stringify(notifications(view)[0].message.content);
					expect(frame).toContain(`status=\\"${status}\\"`);
					return frame;
				};

				it("as failed, with the service's message, when the service reports it failed", async () => {
					const id = await backgrounded();
					Object.assign(task(), {
						status: "failed",
						error: { code: -1, message: "disk full" },
					});
					expect(await woken(id, "failed")).toContain("disk full");
					expect(cancels()).toBe(0);
				});

				it("as failed, cancelling it, when the service asks for more input", async () => {
					const id = await backgrounded();
					task().status = "input_required";
					expect(await woken(id, "failed")).toContain("more input");
					expect(cancels()).toBe(1);
				});

				it("as failed at once when the service no longer knows the task", async () => {
					const id = await backgrounded();
					slow.tasks.delete("task-1");
					expect(await woken(id, "failed")).toContain("no longer knows");
				});

				it("as failed at once when the service refuses the shared request headers", async () => {
					const id = await backgrounded();
					slow.status = 401;
					expect(await woken(id, "failed")).toContain("refused");
				});

				it("as failed once the service could not be asked for five minutes, asking again until then", async () => {
					const id = await backgrounded();
					slow.down = true;
					const asked = slow.requests.length;
					await waitFor(
						async () => slow.requests.length,
						(n) => n > asked,
					);
					expect(
						(await conversations.get(userId, id))?.backgroundCalls[0].status,
					).toBe("running");
					// as if five minutes had passed since the last poll that got an answer
					await db.execute(
						sql`update background_call set polled_at = now() - interval '5 minutes'`,
					);
					expect(await woken(id, "failed")).toContain("5 minutes");
				});

				it("as failed, cancelling it, once tracked longer than the Limits allow", async () => {
					const loaded = await current();
					const saved = loaded.limits;
					loaded.limits = { ...saved, backgroundCallMaxDuration: 1 };
					try {
						const id = await backgrounded();
						expect(await woken(id, "failed")).toContain("1 seconds");
						expect(cancels()).toBe(1);
					} finally {
						loaded.limits = saved;
					}
				});

				it("as failed when its MCP Server is disabled", async () => {
					const loaded = await current();
					const saved = loaded.mcpServers.slow;
					const id = await backgrounded();
					delete loaded.mcpServers.slow;
					try {
						expect(await woken(id, "failed")).toContain("disabled");
					} finally {
						loaded.mcpServers.slow = saved;
					}
				});

				it("as failed, cancelling it, when an Admin deletes its MCP Server", async () => {
					const id = await backgrounded();
					await conversations.deleteMcpServer("slow");
					expect(await woken(id, "failed")).toContain("deleted");
					expect(cancels()).toBe(1);
				});

				it("as failed, cancelling it, when an Admin deletes its MCP Server after disabling it", async () => {
					const loaded = await current();
					const saved = loaded.mcpServers.slow;
					const id = await backgrounded();
					// the next poll far off, so the delete comes before it
					task().pollIntervalMs = 30_000;
					const asked = slow.requests.length;
					await waitFor(
						async () => slow.requests.length,
						(n) => n > asked,
					);
					delete loaded.mcpServers.slow;
					try {
						await conversations.deleteMcpServer("slow");
						expect(await woken(id, "failed")).toContain("deleted");
						expect(cancels()).toBe(1);
					} finally {
						loaded.mcpServers.slow = saved;
					}
				});

				it("as cancelled when the service cancels it", async () => {
					const id = await backgrounded();
					task().status = "cancelled";
					await woken(id, "cancelled");
				});

				describe("of a per-User OAuth MCP Server", () => {
					let shared: Awaited<
						ReturnType<typeof config.current>
					>["mcpServers"][string];
					beforeEach(async () => {
						const loaded = await current();
						shared = loaded.mcpServers.slow;
						loaded.mcpServers.slow = { ...shared, auth: "oauth" };
						// u1 connected through it as the public Client "orqestra"
						as = fakeAuthorizationServer({ resource: shared.url });
						as.accessTokens.add("u1-token");
						as.refreshTokens.set("u1-refresh", "orqestra");
						connections.connections.clear();
						await connections.saveConnection(userId, "slow", {
							tokens: {
								access_token: "u1-token",
								token_type: "Bearer",
								refresh_token: "u1-refresh",
								client_id: "orqestra",
							},
							issuer: "https://as.example.com",
						});
					});
					afterEach(async () => {
						as = undefined;
						(await current()).mcpServers.slow = shared;
					});
					/** Starts a Background Call and waits until its server has been polled with the User's token. */
					const polledAsUser = async () => {
						const id = await backgrounded();
						await waitFor(
							async () => slow.requests,
							(r) =>
								r.some(
									(q) =>
										q.method === "tasks/get" &&
										q.headers.get("authorization") === "Bearer u1-token",
								),
						);
						return id;
					};

					it("polls with its User's token until it is done", async () => {
						const id = await polledAsUser();
						finishTask("as u1");
						expect(await woken(id, "completed")).toContain("as u1");
					});

					it("as failed once its User's Connection is removed", async () => {
						const id = await polledAsUser();
						connections.connections.delete(`${userId} slow`);
						expect(await woken(id, "failed")).toContain("disconnected");
					});

					it("as failed once its User's Connection needs reconnecting", async () => {
						const id = await polledAsUser();
						const c = connections.connections.get(`${userId} slow`);
						if (c) c.status = "needs_reconnect";
						expect(await woken(id, "failed")).toContain("reconnect");
					});

					it("refreshes its User's token when it expires while polling, and completes as usual", async () => {
						const id = await polledAsUser();
						as?.accessTokens.clear();
						const asked = slow.requests.length;
						await waitFor(
							async () => slow.requests.slice(asked),
							(r) => r.some((q) => q.method === "tasks/get"),
						);
						expect(as?.refreshed).toBe(1);
						finishTask("after the refresh");
						expect(await woken(id, "completed")).toContain("after the refresh");
						expect((await connections.connection(userId, "slow"))?.status).toBe(
							"connected",
						);
					});

					it("as failed, needing reconnecting, when its User's token expires and cannot be refreshed", async () => {
						const id = await polledAsUser();
						as?.accessTokens.clear();
						as?.refreshTokens.clear();
						expect(await woken(id, "failed")).toContain("reconnect");
					});

					const cancelledAsUser = () =>
						waitFor(
							async () => slow.requests,
							(r) =>
								r.some(
									(q) =>
										q.method === "tasks/cancel" &&
										q.headers.get("authorization") === "Bearer u1-token",
								),
						);

					it("is cancelled with its User's token when the User cancels it", async () => {
						const id = await polledAsUser();
						const view = await conversations.get(userId, id);
						const toolCallId = view?.backgroundCalls[0].toolCallId ?? "";
						expect(
							await conversations.cancelBackgroundCall(userId, id, toolCallId),
						).toBe(true);
						await cancelledAsUser();
					});

					it("is cancelled with its User's token when the User stops its Conversation", async () => {
						const id = await polledAsUser();
						await conversations.stop(userId, id);
						await cancelledAsUser();
					});
				});

				it("keeps tracking with the new request headers when an Admin edits its MCP Server", async () => {
					const loaded = await current();
					const saved = loaded.mcpServers.slow;
					const id = await backgrounded();
					loaded.mcpServers.slow = { ...saved, headers: { "x-key": "new" } };
					try {
						const asked = slow.requests.length;
						await waitFor(
							async () => slow.requests.slice(asked),
							(r) => r.some((q) => q.headers.get("x-key") === "new"),
						);
						finishTask("still here");
						expect(await woken(id, "completed")).toContain("still here");
					} finally {
						loaded.mcpServers.slow = saved;
					}
				});
			});
		});
	},
);
