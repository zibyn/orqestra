import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/config";
import type { ConversationEvent } from "@orqestra/db";
import { createPostgresBackend, Worker } from "bullmq";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db, AGENT_RUNS_QUEUE } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { config } = await import("#/lib/config");
const conversations = await import("#/lib/conversations");
// the worker runs in-process so the test drives the real queue -> worker -> NOTIFY path
const { startAgentWorker, providerLimiter } = await import(
	"../../../worker/src/run.ts"
);
const { MAX_SUBAGENT_STEPS } = await import("../../../worker/src/tools.ts");

const faux = fauxProvider({
	provider: "faux",
	models: [
		{ id: "faux-1", reasoning: true },
		{ id: "faux-small", contextWindow: 2000 },
	],
	tokensPerSecond: 400,
});
// a tiny context window so a short history already needs compaction
const smallAgent: AgentDefinition = {
	id: "small",
	name: "Small",
	description: "test Agent",
	instructions: "",
	models: ["faux/faux-small"],
	defaultModel: "faux/faux-small",
	thinking: {},
	compaction: { reserveTokens: 1000, keepRecentTokens: 50 },
	default: false,
	pickable: true,
	allModels: false,
	tools: ["search", "scrape"],
	unavailableModels: [],
};
const fauxAgent: AgentDefinition = {
	id: "faux",
	name: "Faux",
	description: "test Agent",
	instructions: "You are a test.",
	models: ["faux/faux-1"],
	defaultModel: "faux/faux-1",
	thinking: {},
	default: false,
	pickable: true,
	allModels: false,
	tools: ["search", "scrape"],
	unavailableModels: [],
};
const userId = "u1";

// Reads SSE events from a Response body until `until` returns true
async function collect(
	response: Response,
	until: (events: ConversationEvent[]) => boolean,
	onEvent?: (event: ConversationEvent) => void,
) {
	const reader = response
		.body!.pipeThrough(new TextDecoderStream())
		.getReader();
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

// a Subagent reply that never comes; it ends only when the request is aborted
const hang: FauxResponseStep = (_context, options) =>
	new Promise((_, reject) =>
		options?.signal?.addEventListener("abort", () =>
			reject(new Error("aborted")),
		),
	);

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 100; i++) {
		const v = await read();
		if (ok(v)) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}

describe.skipIf(!url)("Conversation runs (Postgres + faux provider)", () => {
	let stopWorker: () => Promise<void>;

	beforeAll(async () => {
		const loaded = await config.get();
		loaded.registry.registerProvider(faux.provider);
		loaded.models.push(...faux.models);
		loaded.agents.push(fauxAgent, smallAgent);
		loaded.tools.search = {
			provider: "tavily",
			apiKey: "k",
			baseUrl: "https://api.tavily.com",
		};
		// faux replies are one shared queue, so runs go one at a time; "works on several Runs at once" lifts that
		stopWorker = await startAgentWorker(config.get, url as string, {
			concurrency: 1,
		});
	});
	afterAll(() => stopWorker?.());
	afterEach(() => vi.unstubAllGlobals());

	beforeEach(async () => {
		await db.execute(sql`truncate "user" cascade`);
		await db
			.insert(schema.user)
			.values({ id: userId, name: "U", email: "u@x.io" });
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

		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "hi",
		});
		const response = await conversations.conversationEvents(
			userId,
			id,
			new AbortController().signal,
		);
		expect(response?.headers.get("content-type")).toBe("text/event-stream");
		// the reply starts only once the SSE stream is listening
		release();
		const events = await collect(
			response as Response,
			(es) => es.some((e) => e.type === "start") && es.at(-1)?.type === "saved",
		);

		expect(text(events, "thinking")).toBe("let me think");
		expect(text(events, "text")).toBe("Hello there");

		const view = await waitFor(
			() => conversations.getConversation(userId, id),
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

	it("stops generating when asked and keeps what was generated", async () => {
		const long = "word ".repeat(2000);
		faux.setResponses([fauxAssistantMessage(long), fauxAssistantMessage("T")]);

		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "write a lot",
		});
		const response = await conversations.conversationEvents(
			userId,
			id,
			new AbortController().signal,
		);
		let stopped = false;
		await collect(
			response as Response,
			(es) => es.at(-1)?.type === "saved",
			(e) => {
				if (e.type === "delta" && !stopped) {
					stopped = true;
					void conversations.stopRun(userId, id);
				}
			},
		);

		const view = await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.messages.length === 2 && v.status !== "running",
		);
		const reply = view?.messages[1].message as AssistantMessage;
		expect(reply.stopReason).toBe("aborted");
		expect(JSON.stringify(reply.content).length).toBeLessThan(long.length);
		// a stopped first reply still names the Conversation
		await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.title === "T",
		);
	});

	it("stops a run that is still queued", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let replying = false;
		let ranQueued = false;
		faux.setResponses([
			async () => {
				replying = true;
				await gate;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("T"),
			() => {
				ranQueued = true;
				return fauxAssistantMessage("should not run");
			},
		]);
		// the suite's worker runs one job at a time, so the second Conversation waits
		const busy = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "a",
		});
		await waitFor(async () => replying, Boolean);
		const queued = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "b",
		});
		await conversations.stopRun(userId, queued);
		release();

		await waitFor(
			() => conversations.getConversation(userId, busy),
			(v) => v?.status === "idle" && v.title === "T",
		);
		const view = await conversations.getConversation(userId, queued);
		expect(view?.status).toBe("idle");
		expect(view?.messages.map((m) => m.message.role)).toEqual(["user"]);
		expect(ranQueued).toBe(false);
	});

	it("stops a run while it compacts", async () => {
		const [conv] = await db
			.insert(schema.conversation)
			.values({ userId, agentId: "small", title: "t" })
			.returning();
		const old = fauxAssistantMessage("b".repeat(2000));
		old.usage.totalTokens = 1500;
		await db.insert(schema.message).values(
			[{ role: "user", content: "a".repeat(4000), timestamp: 1 }, old].map(
				(m) => ({
					conversationId: conv.id,
					message: m,
					model: "faux/faux-small",
					thinkingLevel: "off",
				}),
			),
		);
		let compacting = false;
		let replied = false;
		faux.setResponses([
			() => {
				compacting = true;
				// the summary streams slowly enough to be stopped
				return fauxAssistantMessage("s".repeat(4000));
			},
			() => {
				replied = true;
				return fauxAssistantMessage("should not run");
			},
		]);
		await conversations.sendMessage(userId, {
			conversationId: conv.id,
			text: "next?",
		});
		await waitFor(async () => compacting, Boolean);
		await conversations.stopRun(userId, conv.id);

		const view = await waitFor(
			() => conversations.getConversation(userId, conv.id),
			(v) => v?.status !== "running",
		);
		expect(view?.status).toBe("idle");
		expect(view?.messages).toHaveLength(3);
		expect(view?.compactedBefore).toEqual([]);
		expect(replied).toBe(false);
	});

	it("marks a failed reply as failed without saving it", async () => {
		faux.setResponses([
			fauxAssistantMessage("half", {
				stopReason: "error",
				errorMessage: "boom",
			}),
		]);
		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "hi",
		});
		const view = await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.status === "failed",
		);
		expect(view?.messages.map((m) => m.message.role)).toEqual(["user"]);
	});

	it("compacts a long history before the turn but keeps it all visible", async () => {
		const [conv] = await db
			.insert(schema.conversation)
			.values({ userId, agentId: "small", title: "t" })
			.returning();
		const old = fauxAssistantMessage("b".repeat(2000));
		old.usage.totalTokens = 1500; // what the provider reported for that turn
		await db.insert(schema.message).values(
			[{ role: "user", content: "a".repeat(4000), timestamp: 1 }, old].map(
				(m) => ({
					conversationId: conv.id,
					message: m,
					model: "faux/faux-small",
					thinkingLevel: "off",
				}),
			),
		);
		let seen = "";
		faux.setResponses([
			fauxAssistantMessage("SUMMARY OF EARLIER"),
			(ctx) => {
				seen = JSON.stringify(ctx.messages);
				return fauxAssistantMessage("ok");
			},
		]);

		await conversations.sendMessage(userId, {
			conversationId: conv.id,
			text: "next?",
		});
		const view = await waitFor(
			() => conversations.getConversation(userId, conv.id),
			(v) => v?.status === "idle",
		);
		expect(seen).toContain("SUMMARY OF EARLIER");
		expect(seen).not.toContain("aaaa");
		expect(view?.messages).toHaveLength(4);
		expect(view?.compactedBefore).toEqual([view?.messages[2].id]);
	});

	it("saves a Tool call and its result as part of the Turn", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						results: [
							{ title: "Pi", url: "https://pi.dev", content: "An agent" },
						],
					}),
				),
		);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("search", { query: "pi", count: 1 })),
			fauxAssistantMessage("Pi is an agent"),
			fauxAssistantMessage("T"),
		]);
		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "what is pi?",
		});
		const view = await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.title === "T",
		);
		expect(view?.messages.map((m) => m.message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		const result = view?.messages[2].message as ToolResultMessage;
		expect(result.toolName).toBe("search");
		expect(JSON.stringify(result.content)).toContain("https://pi.dev");
	});

	it("hands a task to a Subagent that starts fresh and returns its final answer when waited for", async () => {
		const seen: { messages: { role: string; toolsAdded?: unknown }[] }[] = [];
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "find pi" }] }),
				),
				fauxAssistantMessage(fauxToolCall("subagent_wait", {})),
				fauxAssistantMessage("Done"),
			],
			sub: [
				(context) => {
					seen.push(context as (typeof seen)[number]);
					return fauxAssistantMessage("pi is at pi.dev");
				},
			],
		});
		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "research pi",
		});
		const view = await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.title === "T",
		);
		// the Subagent saw only the brief, not the Conversation, and cannot start Subagents in turn
		const [system, ...rest] = seen[0].messages;
		expect(rest).toMatchObject([{ role: "user", content: "find pi" }]);
		expect(JSON.stringify(system.toolsAdded)).not.toContain("subagent");
		expect(view?.messages.map((m) => m.message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
			"assistant",
		]);
		const started = view?.messages[2].message as ToolResultMessage;
		expect(JSON.stringify(started.content)).toContain("Started subagent 1");
		const waited = view?.messages[4].message as ToolResultMessage;
		expect(JSON.stringify(waited.content)).toContain(
			'<result subagent=\\"1\\" status=\\"completed\\">\\npi is at pi.dev',
		);
		// its whole process is kept under the call that started it
		expect(view?.subagents).toMatchObject([
			{
				toolCallId: started.toolCallId,
				number: 1,
				brief: "find pi",
				status: "completed",
				messages: [{ role: "user" }, { role: "assistant" }],
			},
		]);
	});

	it("gives a Subagent at its step limit one last request without Tools for its answer", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response(JSON.stringify({ results: [] })),
		);
		let last: unknown;
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "dig" }] }),
				),
				fauxAssistantMessage(fauxToolCall("subagent_wait", {})),
				fauxAssistantMessage("Done"),
			],
			sub: [
				...Array.from({ length: MAX_SUBAGENT_STEPS - 1 }, (_, i) =>
					fauxAssistantMessage([
						fauxText(`step ${i + 1}`),
						fauxToolCall("search", { query: "more" }),
					]),
				),
				(context) => {
					last = context;
					return fauxAssistantMessage("what I found");
				},
			],
		});
		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "dig deep",
		});
		const view = await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.title === "T",
		);
		expect(JSON.stringify(last)).toContain("step limit");
		const waited = view?.messages[4].message as ToolResultMessage;
		expect(JSON.stringify(waited.content)).toContain('status=\\"partial\\"');
		expect(JSON.stringify(waited.content)).toContain("what I found");
		expect(view?.subagents[0].status).toBe("partial");
	});

	it("passes a message to a running Subagent after its current step", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response(JSON.stringify({ results: [] })),
		);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let second: unknown;
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "look" }] }),
				),
				fauxAssistantMessage(
					fauxToolCall("subagent_message", {
						number: 1,
						message: "also check the docs",
					}),
				),
				() => {
					release();
					return fauxAssistantMessage(fauxToolCall("subagent_wait", {}));
				},
				fauxAssistantMessage("Done"),
			],
			sub: [
				async () => {
					await gate;
					return fauxAssistantMessage(fauxToolCall("search", { query: "a" }));
				},
				(context) => {
					second = context;
					return fauxAssistantMessage("checked");
				},
			],
		});
		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "look",
		});
		const view = await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.title === "T",
		);
		expect(JSON.stringify(second)).toContain("also check the docs");
		expect(view?.subagents[0].status).toBe("completed");
	});

	it("stops a Subagent on request, and those still running once the reply is done", async () => {
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						tasks: [{ brief: "one" }, { brief: "two" }],
					}),
				),
				fauxAssistantMessage(fauxToolCall("subagent_stop", { numbers: [1] })),
				fauxAssistantMessage("Done"),
			],
			sub: [hang, hang],
		});
		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "go",
		});
		const view = await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.title === "T",
		);
		const stopped = view?.messages[4].message as ToolResultMessage;
		expect(JSON.stringify(stopped.content)).toContain(
			'<result subagent=\\"1\\" status=\\"stopped\\">',
		);
		expect(view?.status).toBe("idle");
		expect(view?.subagents.map((s) => s.status)).toEqual([
			"stopped",
			"stopped",
		]);
	});

	it("hides a Conversation from everyone but its owner", async () => {
		faux.setResponses([fauxAssistantMessage("hi"), fauxAssistantMessage("T")]);
		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "hi",
		});
		await db
			.insert(schema.user)
			.values({ id: "admin", name: "A", email: "a@x.io", role: "admin" });
		expect(await conversations.getConversation("admin", id)).toBeUndefined();
		expect(await conversations.listConversations("admin")).toEqual([]);
		expect(
			await conversations.conversationEvents(
				"admin",
				id,
				new AbortController().signal,
			),
		).toBeUndefined();
	});

	// last: it swaps the worker for one that notices stalled runs quickly
	it("works on several Runs at once", async () => {
		await stopWorker();
		stopWorker = await startAgentWorker(config.get, url as string);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let replying = 0;
		const gated = async () => {
			replying++;
			await gate;
			return fauxAssistantMessage("done");
		};
		faux.setResponses([
			gated,
			gated,
			fauxAssistantMessage("T"),
			fauxAssistantMessage("T"),
		]);
		const ids = [
			await conversations.sendMessage(userId, { agentId: "faux", text: "a" }),
			await conversations.sendMessage(userId, { agentId: "faux", text: "b" }),
		];
		// both replies are underway before either may finish
		await waitFor(
			async () => replying,
			(n) => n === 2,
		);
		release();
		for (const id of ids)
			await waitFor(
				() => conversations.getConversation(userId, id),
				(v) => v?.status === "idle" && v.title === "T",
			);
		await stopWorker();
		stopWorker = await startAgentWorker(config.get, url as string, {
			concurrency: 1,
		});
	});

	it("fails a run whose worker crashed, so it can be retried", async () => {
		await stopWorker();
		let picked = false;
		// a worker that takes the job and then dies without finishing it
		const crashing = new Worker(
			AGENT_RUNS_QUEUE,
			() => {
				picked = true;
				return new Promise(() => {});
			},
			{ connection: { connectionString: url as string }, lockDuration: 300 },
			createPostgresBackend,
		);
		faux.setResponses([fauxAssistantMessage("retried")]);
		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "hi",
		});
		await waitFor(async () => picked, Boolean);
		await crashing.close(true);

		stopWorker = await startAgentWorker(config.get, url as string, {
			stalledInterval: 200,
			concurrency: 1,
		});
		await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.status === "failed",
		);
		await conversations.retryRun(userId, id);
		const view = await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.status === "idle",
		);
		expect(view?.messages.map((m) => m.message.role)).toEqual([
			"user",
			"assistant",
		]);
	}, 15_000);
});

describe("providerLimiter", () => {
	// a stream that ends when its test says so
	function streams() {
		const started: string[] = [];
		const end: Record<string, () => void> = {};
		const streamSimple = ((model: { provider: string; id: string }) => {
			started.push(model.id);
			const result = new Promise((resolve) => {
				end[model.id] = () => resolve({});
			});
			return { result: () => result };
		}) as unknown as Parameters<ReturnType<typeof providerLimiter>>[0];
		return { started, end, streamSimple };
	}
	const model = (provider: string, id: string) => ({ provider, id }) as never;
	const tick = () => new Promise((r) => setTimeout(r, 0));

	it("holds a Provider's slot until the stream ends, without blocking other Providers", async () => {
		const { started, end, streamSimple } = streams();
		const limited = providerLimiter(1)(streamSimple);
		void limited(model("a", "a1"), { messages: [] });
		void limited(model("a", "a2"), { messages: [] });
		void limited(model("b", "b1"), { messages: [] });
		await tick();
		expect(started).toEqual(["a1", "b1"]);
		end.a1();
		await tick();
		expect(started).toEqual(["a1", "b1", "a2"]);
	});

	it("drops a queued request when its signal aborts", async () => {
		const { started, streamSimple } = streams();
		const limited = providerLimiter(1)(streamSimple);
		void limited(model("a", "a1"), { messages: [] });
		const stop = new AbortController();
		const queued = limited(
			model("a", "a2"),
			{ messages: [] },
			{ signal: stop.signal },
		);
		stop.abort(new Error("stopped"));
		await expect(queued).rejects.toThrow("stopped");
		expect(started).toEqual(["a1"]);
	});
});
