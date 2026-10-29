import {
	afterAll,
	afterEach,
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
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/config";
import type { ConversationEvent } from "@orqestra/conversations";

// The runtime replying through the real @orqestra/conversations (lifecycle scenarios are tested there):
// needs TEST_DATABASE_URL, which src/test-env.ts sets up
const url = process.env.TEST_DATABASE_URL;
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { liveConfig } = await import("@orqestra/config/live");
const { createConversations } = await import("@orqestra/conversations");
const { providerLimiter, startAgentWorker } = await import("./run.ts");
const { MAX_SUBAGENT_STEPS } = await import("./tools.ts");

const config = liveConfig();
const conversations = createConversations({ config: config.get });
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

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 100; i++) {
		const v = await read();
		if (ok(v)) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}

const realFetch = globalThis.fetch;
// Search answers with no results
const stubSearch = (results: unknown[] = []) => {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ results }))) as unknown as typeof fetch;
};

describe.skipIf(!url)(
	"Runs replied by the runtime (Postgres + faux provider)",
	() => {
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
			// faux replies are one shared queue, so runs go one at a time
			stopWorker = await startAgentWorker(config.get, { concurrency: 1 });
		});
		afterAll(async () => {
			await stopWorker?.();
			await config.close();
		});
		afterEach(() => {
			globalThis.fetch = realFetch;
		});

		beforeEach(async () => {
			// Subagents may outlive a test: stop them so they neither linger nor hold up stopping the worker
			await db.execute(
				sql`select pg_notify('conversation_stop', id::text) from conversation where status = 'running'`,
			);
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

		it("stops generating when asked and keeps what was generated", async () => {
			const long = "word ".repeat(2000);
			faux.setResponses([
				fauxAssistantMessage(long),
				fauxAssistantMessage("T"),
			]);

			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "write a lot",
			});
			const stream = await conversations.subscribe(
				userId,
				id,
				new AbortController().signal,
			);
			let stopped = false;
			await collect(
				stream as ReadableStream,
				(es) => es.at(-1)?.type === "saved",
				(e) => {
					if (e.type === "delta" && !stopped) {
						stopped = true;
						void conversations.stop(userId, id);
					}
				},
			);

			const view = await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.messages.length === 2 && v.status !== "running",
			);
			const reply = view?.messages[1].message as AssistantMessage;
			expect(reply.stopReason).toBe("aborted");
			expect(JSON.stringify(reply.content).length).toBeLessThan(long.length);
			// a stopped first reply still names the Conversation
			await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.title === "T",
			);
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

			await conversations.send(userId, {
				conversationId: conv.id,
				text: "next?",
			});
			const view = await waitFor(
				() => conversations.get(userId, conv.id),
				(v) => v?.status === "idle",
			);
			expect(seen).toContain("SUMMARY OF EARLIER");
			expect(seen).not.toContain("aaaa");
			expect(view?.messages).toHaveLength(4);
			expect(view?.compactedBefore).toEqual([view?.messages[2].id as number]);
		});

		it("saves a Tool call and its result as part of the Turn", async () => {
			stubSearch([{ title: "Pi", url: "https://pi.dev", content: "An agent" }]);
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("search", { query: "pi", count: 1 })),
				fauxAssistantMessage("Pi is an agent"),
				fauxAssistantMessage("T"),
			]);
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "what is pi?",
			});
			const view = await waitFor(
				() => conversations.get(userId, id),
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

		it("gives a Subagent at its step limit one last request without Tools for its answer", async () => {
			stubSearch();
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
			// a Subagent cannot start Subagents in turn
			expect(JSON.stringify(first?.messages[0].toolsAdded)).not.toContain(
				"subagent",
			);
			expect(JSON.stringify(last)).toContain("step limit");
			const notified = JSON.stringify(view?.messages[4].message.content);
			expect(notified).toContain('status=\\"partial\\"');
			expect(notified).toContain("what I found");
			expect(view?.subagents[0].outcome).toBe("partial");
		});

		it("delivers a message sent while running at the next step boundary, into the model's context", async () => {
			stubSearch();
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			let replying = false;
			let seen: string[] = [];
			faux.setResponses([
				async () => {
					replying = true;
					await gate;
					return fauxAssistantMessage(fauxToolCall("search", { query: "x" }));
				},
				(context) => {
					seen = context.messages.flatMap((m) =>
						m.role === "user" && typeof m.content === "string"
							? [m.content]
							: [],
					);
					return fauxAssistantMessage("Got both");
				},
				fauxAssistantMessage("T"),
			]);
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "first",
			});
			await waitFor(async () => replying, Boolean);
			await conversations.send(userId, {
				conversationId: id,
				text: "also this",
			});
			// queued, not yet delivered
			const queued = await conversations.get(userId, id);
			expect(queued?.messages.at(-1)).toMatchObject({
				message: { role: "user", content: "also this" },
			});
			expect(queued?.messages.at(-1)?.queued).toBe(true);
			release();

			const view = await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.status === "idle" && v.title === "T",
			);
			expect(seen).toEqual(["first", "also this"]);
			expect(view?.messages.map((m) => m.message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"user",
				"assistant",
			]);
		});
	},
);

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
