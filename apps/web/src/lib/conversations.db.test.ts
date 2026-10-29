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
import { type AgentDefinition, messageText } from "@orqestra/config";
import type { ConversationEvent } from "@orqestra/conversations";
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
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { config } = await import("#/lib/config");
const { conversations } = await import("#/lib/conversations");
const runs = await import("@orqestra/conversations/runs");
const { AGENT_RUNS_QUEUE, STOP_CHANNEL } = runs;
// the worker runs in-process so the test drives the real queue -> worker -> NOTIFY path
const { startAgentWorker, providerLimiter } = await import(
	"../../../worker/src/run.ts"
);
const { MAX_SUBAGENT_STEPS } = await import("../../../worker/src/tools.ts");
const { MAX_SUBAGENTS, MAX_SUBAGENTS_PER_USER_MESSAGE } = await import(
	"@orqestra/conversations"
);

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
		stopWorker = await startAgentWorker(config.get, {
			concurrency: 1,
		});
	});
	afterAll(() => stopWorker?.());
	afterEach(() => vi.unstubAllGlobals());

	beforeEach(async () => {
		// Subagents may outlive a test: stop them so they neither linger nor hold up stopping the worker
		await db.execute(
			sql`select pg_notify(${STOP_CHANNEL}, id::text) from conversation where status = 'running'`,
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
		const response = await conversations.subscribe(
			userId,
			id,
			new AbortController().signal,
		);
		// the reply starts only once the SSE stream is listening
		release();
		const events = await collect(
			response as ReadableStream,
			(es) => es.some((e) => e.type === "start") && es.at(-1)?.type === "saved",
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
		faux.setResponses([fauxAssistantMessage(long), fauxAssistantMessage("T")]);

		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "write a lot",
		});
		const response = await conversations.subscribe(
			userId,
			id,
			new AbortController().signal,
		);
		let stopped = false;
		await collect(
			response as ReadableStream,
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
		const busy = await conversations.send(userId, {
			agentId: "faux",
			text: "a",
		});
		await waitFor(async () => replying, Boolean);
		const queued = await conversations.send(userId, {
			agentId: "faux",
			text: "b",
		});
		await conversations.stop(userId, queued);
		release();

		await waitFor(
			() => conversations.get(userId, busy),
			(v) => v?.status === "idle" && v.title === "T",
		);
		const view = await conversations.get(userId, queued);
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
		await conversations.send(userId, {
			conversationId: conv.id,
			text: "next?",
		});
		await waitFor(async () => compacting, Boolean);
		await conversations.stop(userId, conv.id);

		const view = await waitFor(
			() => conversations.get(userId, conv.id),
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
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "hi",
		});
		const view = await waitFor(
			() => conversations.get(userId, id),
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

	it("wakes the parent with a Notification when a Subagent finishes after the parent's reply", async () => {
		const seen: { messages: { role: string; toolsAdded?: unknown }[] }[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "find pi" }] }),
				),
				fauxAssistantMessage("I asked a subagent and will report back"),
				fauxAssistantMessage("pi is at pi.dev"),
			],
			sub: [
				async (context) => {
					seen.push(context as (typeof seen)[number]);
					await gate;
					return fauxAssistantMessage("found: pi.dev");
				},
			],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "research pi",
		});
		// the parent's reply is done while its Subagent still works
		const replied = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.messages.length === 4,
		);
		expect(replied?.subagents[0].outcome).toBe("running");
		// the sidebar marks a Conversation whose Subagents still work in the background
		expect(await conversations.list(userId)).toMatchObject([
			{ id, background: true },
		]);
		release();
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.messages.length === 6,
		);
		expect(view?.messages.map((m) => m.message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"user",
			"assistant",
		]);
		const started = view?.messages[2].message as ToolResultMessage;
		expect(JSON.stringify(started.content)).toContain("Started subagent 1");
		expect(view?.messages[4].message.content).toContain(
			'<task-notification subagent="1" status="completed">\nfound: pi.dev',
		);
		// the Subagent saw only the brief, not the Conversation, and cannot start Subagents in turn
		const [system, ...rest] = seen[0].messages;
		expect(rest).toMatchObject([{ role: "user", content: "find pi" }]);
		expect(JSON.stringify(system.toolsAdded)).not.toContain("subagent");
		expect(view?.subagents).toMatchObject([
			{
				toolCallId: started.toolCallId,
				number: 1,
				brief: "find pi",
				outcome: "completed",
			},
		]);
		// the parent carries its Subagents' metadata only; a panel loads a transcript when opened
		expect(view?.subagents[0]).not.toHaveProperty("messages");
		const sub = view?.subagents[0].id as string;
		expect(
			(await conversations.subagentTranscript(userId, sub))?.map((m) => m.role),
		).toEqual(["user", "assistant"]);
		expect(await conversations.subagentTranscript("u2", sub)).toBeUndefined();
		// the Notification knows which Subagent it came from, so it can open that panel
		expect(view?.messages[4].subagentId).toBe(sub);
		// the parent is idle with no Subagent left in the background
		expect(await conversations.list(userId)).toMatchObject([
			{ id, background: false },
		]);
		// a Subagent's Conversation is reached through its parent only
		expect(await conversations.list(userId)).toMatchObject([{ id }]);
	});

	it("streams a Subagent's reply over SSE under its row id", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "find pi" }] }),
				),
				fauxAssistantMessage("Started"),
				fauxAssistantMessage("Done"),
			],
			sub: [
				async () => {
					await gate;
					return fauxAssistantMessage("pi is at pi.dev");
				},
			],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "research pi",
		});
		const response = await conversations.subscribe(
			userId,
			id,
			new AbortController().signal,
		);
		release();
		const events = await collect(response as ReadableStream, (es) =>
			es.some((e) => e.type === "end" && e.subagent),
		);
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.messages.length === 6,
		);
		const sub = view?.subagents[0].id;
		const mine = events.filter((e) => "subagent" in e && e.subagent === sub);
		expect(mine.map((e) => e.type)).toEqual(
			expect.arrayContaining(["start", "delta", "end"]),
		);
		expect(text(mine, "text")).toBe("pi is at pi.dev");
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
				fauxAssistantMessage("Digging"),
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
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "dig deep",
		});
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.messages.length === 6,
		);
		expect(JSON.stringify(last)).toContain("step limit");
		const notified = JSON.stringify(view?.messages[4].message.content);
		expect(notified).toContain('status=\\"partial\\"');
		expect(notified).toContain("what I found");
		expect(view?.subagents[0].outcome).toBe("partial");
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
					return fauxAssistantMessage("Looking");
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
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "look",
		});
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) =>
				v?.status === "idle" &&
				v.messages.at(-1)?.message.role === "assistant" &&
				v.subagents[0]?.outcome === "completed" &&
				v.messages.length === 8,
		);
		expect(JSON.stringify(second)).toContain("also check the docs");
		expect(JSON.stringify(view?.messages[6].message.content)).toContain(
			"checked",
		);
	});

	it("stops a Subagent on request, and all of them, without waking the parent, when the User stops", async () => {
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						tasks: [{ brief: "one" }, { brief: "two" }],
					}),
				),
				fauxAssistantMessage(fauxToolCall("subagent_stop", { numbers: [1] })),
				fauxAssistantMessage("Two keeps going"),
			],
			sub: [hang, hang],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "go",
		});
		// the parent's reply is done, and the Subagent it did not stop works on
		const replied = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.title === "T" && v.subagents[0]?.outcome === "stopped",
		);
		expect(replied?.status).toBe("idle");
		expect(replied?.subagents[1].outcome).toBe("running");

		await conversations.stop(userId, id);
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.subagents[1]?.outcome === "stopped",
		);
		// a stopped Subagent's Notification waits for the User's next message instead of waking the parent
		await new Promise((r) => setTimeout(r, 300));
		const after = await conversations.get(userId, id);
		expect(after?.status).toBe("idle");
		expect(
			after?.messages.filter((m) => m.message.role === "assistant"),
		).toHaveLength(
			view?.messages.filter((m) => m.message.role === "assistant").length ?? 0,
		);
		expect(
			after?.messages.filter((m) =>
				JSON.stringify(m.message.content).includes('status=\\"stopped\\"'),
			),
		).toHaveLength(2);
	});

	it("stops one Subagent from its panel, leaving the others and the parent as they are", async () => {
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						tasks: [{ brief: "one" }, { brief: "two" }],
					}),
				),
				fauxAssistantMessage("Both started"),
			],
			sub: [hang, hang],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "go",
		});
		const replied = await waitFor(
			() => conversations.get(userId, id),
			(v) =>
				v?.status === "idle" &&
				v.title === "T" &&
				v.subagents.every((s) => s.outcome === "running"),
		);
		const [one, two] = replied?.subagents ?? [];
		// nobody else can stop it
		await conversations.stopSubagent("u2", one.id);
		await conversations.stopSubagent(userId, one.id);
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.subagents[0]?.outcome === "stopped",
		);
		expect(view?.subagents[1]).toMatchObject({
			id: two.id,
			outcome: "running",
		});
		expect(view?.status).toBe("idle");
		await conversations.stop(userId, id);
	});

	it("delivers a Notification that arrives while the parent runs between its steps, without another Run", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response(JSON.stringify({ results: [] })),
		);
		let seen = "";
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "find pi" }] }),
				),
				// keeps the parent's Run going until its Subagent has finished
				async () => {
					await waitFor(
						() => db.select().from(schema.subagent),
						(rows) => rows[0]?.outcome === "completed",
					);
					return fauxAssistantMessage(fauxToolCall("search", { query: "pi" }));
				},
				(context) => {
					seen = JSON.stringify(context.messages.at(-1));
					return fauxAssistantMessage("pi is at pi.dev");
				},
			],
			sub: [fauxAssistantMessage("found: pi.dev")],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "research pi",
		});
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.title === "T",
		);
		expect(view?.messages.map((m) => m.message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
			"user",
			"assistant",
		]);
		expect(seen).toContain("task-notification");
	});

	it("continues a finished Subagent that is messaged, which then notifies the parent again", async () => {
		let second = "";
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "find pi" }] }),
				),
				fauxAssistantMessage("Asked"),
				fauxAssistantMessage(
					fauxToolCall("subagent_message", {
						number: 1,
						message: "now find tau",
					}),
				),
				fauxAssistantMessage("Asked again"),
				fauxAssistantMessage("pi and tau found"),
			],
			sub: [
				fauxAssistantMessage("found: pi.dev"),
				(context) => {
					second = JSON.stringify(context.messages);
					return fauxAssistantMessage("found: tau.dev");
				},
			],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "research",
		});
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.messages.length === 10,
		);
		// it continues with what it did before
		expect(second).toContain("find pi");
		expect(second).toContain("found: pi.dev");
		expect(second).toContain("now find tau");
		expect(JSON.stringify(view?.messages[8].message.content)).toContain(
			"found: tau.dev",
		);
		expect(view?.subagents[0].outcome).toBe("completed");
	});

	it("wakes the parent when a Subagent fails", async () => {
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "find pi" }] }),
				),
				fauxAssistantMessage("Asked"),
				fauxAssistantMessage("It failed, I will look myself"),
			],
			sub: [
				fauxAssistantMessage("half", {
					stopReason: "error",
					errorMessage: "boom",
				}),
			],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "research",
		});
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.messages.length === 6,
		);
		const notified = JSON.stringify(view?.messages[4].message.content);
		expect(notified).toContain('status=\\"failed\\"');
		expect(notified).toContain("boom");
		expect(view?.subagents[0].outcome).toBe("failed");
	});

	it(`runs at most ${MAX_SUBAGENTS} Subagents of a parent at once, the rest when one finishes`, async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const gated = async () => {
			await gate;
			return fauxAssistantMessage("done");
		};
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						tasks: Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => ({
							brief: `task ${i + 1}`,
						})),
					}),
				),
				fauxAssistantMessage("Asked"),
				...Array.from({ length: MAX_SUBAGENTS + 1 }, () =>
					fauxAssistantMessage("ok"),
				),
			],
			sub: Array.from({ length: MAX_SUBAGENTS + 1 }, () => gated),
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "go",
		});
		const busy = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.subagents.length === MAX_SUBAGENTS + 1,
		);
		expect(busy?.subagents.map((s) => s.outcome)).toEqual([
			...Array(MAX_SUBAGENTS).fill("running"),
			"queued",
		]);
		release();
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) =>
				v?.status === "idle" &&
				v.subagents.every((s) => s.outcome === "completed") &&
				v.messages.filter((m) =>
					JSON.stringify(m.message.content).includes("task-notification"),
				).length ===
					MAX_SUBAGENTS + 1 &&
				v.messages.at(-1)?.message.role === "assistant",
		);
		expect(view?.messages.every((m) => !m.queued)).toBe(true);
	});

	it(`refuses to start more than ${MAX_SUBAGENTS_PER_USER_MESSAGE} Subagents since the User's last message`, async () => {
		const eight = Array.from({ length: 8 }, (_, i) => ({ brief: `t${i}` }));
		script({
			parent: [
				fauxAssistantMessage(fauxToolCall("subagent", { tasks: eight })),
				fauxAssistantMessage(fauxToolCall("subagent", { tasks: eight })),
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "one more" }] }),
				),
				...Array.from({ length: 40 }, () => fauxAssistantMessage("ok")),
			],
			sub: Array.from({ length: 16 }, () => fauxAssistantMessage("done")),
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "go",
		});
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) =>
				v?.status === "idle" &&
				v.subagents.length === 16 &&
				v.subagents.every((s) => s.outcome === "completed"),
		);
		// Notifications may land between the calls
		const results = view?.messages
			.map((m) => m.message)
			.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(results?.map((r) => r.isError)).toEqual([false, false, true]);
		const refused = results?.[2];
		expect(JSON.stringify(refused?.content)).toContain(
			"do the rest of the work yourself",
		);
	}, 15_000);

	it("counts Subagents started and finished ones continued against the budget, not messages to running ones", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "one" }] }),
				),
				// steering a running Subagent is not continuing it
				fauxAssistantMessage(
					Array.from({ length: MAX_SUBAGENTS_PER_USER_MESSAGE }, (_, i) =>
						fauxToolCall("subagent_message", { number: 1, message: `m${i}` }),
					),
				),
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "two" }] }),
				),
				() => {
					release();
					return fauxAssistantMessage("Waiting");
				},
				...Array.from({ length: 4 }, () => fauxAssistantMessage("ok")),
			],
			sub: [
				async () => {
					await gate;
					return fauxAssistantMessage("done");
				},
				...Array.from({ length: 3 }, () => fauxAssistantMessage("done")),
			],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "go",
		});
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) =>
				v?.status === "idle" &&
				v.subagents.length === 2 &&
				v.subagents.every((s) => s.outcome === "completed") &&
				v.messages.at(-1)?.message.role === "assistant",
		);
		const results = view?.messages
			.map((m) => m.message)
			.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(results?.every((r) => !r.isError)).toBe(true);
	});

	it("queues a finished Subagent that is messaged while no slot is free, so the User's stop reaches it", async () => {
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "first" }] }),
				),
				async () => {
					await waitFor(
						() => db.select().from(schema.subagent),
						(rows) => rows[0]?.outcome === "completed",
					);
					return fauxAssistantMessage(
						fauxToolCall("subagent", {
							tasks: Array.from({ length: MAX_SUBAGENTS }, (_, i) => ({
								brief: `busy ${i}`,
							})),
						}),
					);
				},
				fauxAssistantMessage(
					fauxToolCall("subagent_message", { number: 1, message: "more" }),
				),
				fauxAssistantMessage("Waiting"),
			],
			sub: [
				fauxAssistantMessage("done"),
				...Array.from({ length: MAX_SUBAGENTS }, () => hang),
			],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "go",
		});
		const replied = await waitFor(
			() => conversations.get(userId, id),
			(v) =>
				v?.status === "idle" &&
				v.title === "T" &&
				v.subagents.length === MAX_SUBAGENTS + 1,
		);
		expect(replied?.subagents[0].outcome).toBe("queued");
		await conversations.stop(userId, id);
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => !!v?.subagents.every((s) => s.outcome === "stopped"),
		);
		// it never starts again by itself
		await new Promise((r) => setTimeout(r, 300));
		const after = await conversations.get(userId, id);
		expect(after?.subagents.map((s) => s.outcome)).toEqual(
			view?.subagents.map((s) => s.outcome),
		);
	});

	it("fails a Subagent whose Run cannot be queued, with exactly one Notification", async () => {
		const queue = runs.runQueue(true);
		const add = queue.add.bind(queue);
		let calls = 0;
		let broken: unknown;
		// the last Subagent waits for a slot; queueing it, once one is free, keeps failing
		const spy = vi.spyOn(queue, "add").mockImplementation((...args) => {
			if (++calls === MAX_SUBAGENTS + 1) broken = args[1].conversationId;
			return args[1].conversationId === broken
				? Promise.reject(new Error("queue down"))
				: add(...args);
		});
		try {
			script({
				parent: [
					fauxAssistantMessage(
						fauxToolCall("subagent", {
							tasks: Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => ({
								brief: `task ${i + 1}`,
							})),
						}),
					),
					...Array.from({ length: MAX_SUBAGENTS + 3 }, () =>
						fauxAssistantMessage("ok"),
					),
				],
				sub: Array.from({ length: MAX_SUBAGENTS }, () =>
					fauxAssistantMessage("done"),
				),
			});
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "go",
			});
			const view = await waitFor(
				() => conversations.get(userId, id),
				(v) =>
					v?.status === "idle" &&
					v.subagents.at(-1)?.outcome === "failed" &&
					v.messages.at(-1)?.message.role === "assistant",
			);
			await new Promise((r) => setTimeout(r, 300));
			const after = await conversations.get(userId, id);
			expect(after?.subagents.map((s) => s.outcome)).toEqual([
				...Array(MAX_SUBAGENTS).fill("completed"),
				"failed",
			]);
			// one Notification per Subagent
			expect(
				view?.subagents.map(
					(s) => after?.messages.filter((m) => m.subagentId === s.id).length,
				),
			).toEqual(Array(MAX_SUBAGENTS + 1).fill(1));
		} finally {
			spy.mockRestore();
		}
	});

	it("wakes the parent in one Run for two Subagents that finish together, and delivers both Notifications", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let unblock!: () => void;
		const blocked = new Promise<void>((r) => {
			unblock = r;
		});
		let blocking = false;
		let woke: unknown[] = [];
		const gated = async () => {
			await gate;
			return fauxAssistantMessage("done");
		};
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						tasks: [{ brief: "one" }, { brief: "two" }],
					}),
				),
				fauxAssistantMessage("Asked"),
				// another Conversation's reply holds the suite's only top-level slot
				async () => {
					blocking = true;
					await blocked;
					return fauxAssistantMessage("blocked");
				},
				(context) => {
					woke = context.messages;
					return fauxAssistantMessage("Both done");
				},
			],
			sub: [gated, gated],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "go",
		});
		await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.title === "T",
		);
		const [other] = await db
			.insert(schema.conversation)
			.values({ userId, agentId: "faux", titleEdited: true })
			.returning();
		await conversations.send(userId, {
			conversationId: other.id,
			text: "hold on",
		});
		await waitFor(async () => blocking, Boolean);
		release();
		await waitFor(
			() => db.select().from(schema.inbox),
			(rows) => rows.filter((r) => r.conversationId === id).length === 2,
		);
		unblock();
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.messages.length === 7,
		);
		expect(view?.messages.slice(4).map((m) => m.message.role)).toEqual([
			"user",
			"user",
			"assistant",
		]);
		expect(
			woke.filter(
				(m) =>
					(m as { role: string }).role === "user" &&
					JSON.stringify(m).includes("task-notification"),
			),
		).toHaveLength(2);
	});

	it("tells the parent's page when a Subagent compacts", async () => {
		const [parent] = await db
			.insert(schema.conversation)
			.values({ userId, agentId: "faux", title: "t", titleEdited: true })
			.returning();
		const [child] = await db
			.insert(schema.conversation)
			.values({ userId, agentId: "small", parentId: parent.id })
			.returning();
		await db.insert(schema.subagent).values({
			conversationId: child.id,
			parentId: parent.id,
			toolCallId: "call",
			number: 1,
			template: "small",
			brief: "a".repeat(4000),
		});
		const old = fauxAssistantMessage("b".repeat(2000));
		old.usage.totalTokens = 1500;
		await db.insert(schema.message).values(
			[{ role: "user", content: "a".repeat(4000), timestamp: 1 }, old].map(
				(m) => ({
					conversationId: child.id,
					message: m,
					model: "faux/faux-small",
					thinkingLevel: "off",
				}),
			),
		);
		await db.insert(schema.inbox).values({
			conversationId: child.id,
			message: { role: "user", content: "next?", timestamp: Date.now() },
			model: "faux/faux-small",
			thinkingLevel: "off",
			wake: true,
		});
		faux.setResponses([
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("ok"),
		]);
		const response = await conversations.subscribe(
			userId,
			parent.id,
			new AbortController().signal,
		);
		await runs.ensureRun(child.id);
		const events = await collect(response as ReadableStream, (es) =>
			es.some((e) => e.type === "start"),
		);
		// the compaction showed before the reply began
		expect(events.map((e) => e.type)).toEqual(["saved", "start"]);
		await waitFor(
			() => conversations.get(userId, parent.id),
			(v) => v?.status === "idle" && v.messages.length === 2,
		);
	});

	it("answers a message left in the inbox when the User stops the Run", async () => {
		script({
			parent: [
				fauxAssistantMessage("word ".repeat(2000)),
				fauxAssistantMessage("answer"),
			],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "write a lot",
		});
		const response = await conversations.subscribe(
			userId,
			id,
			new AbortController().signal,
		);
		let sent: Promise<void> | undefined;
		await collect(
			response as ReadableStream,
			(es) => es.some((e) => e.type === "delta"),
			(e) => {
				if (e.type === "delta" && !sent)
					sent = (async () => {
						await conversations.send(userId, {
							conversationId: id,
							text: "also this",
						});
						await conversations.stop(userId, id);
					})();
			},
		);
		await sent;
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.messages.length === 4,
		);
		expect(
			view?.messages.map((m) => [m.message.role, messageText(m.message)]),
		).toMatchObject([
			["user", "write a lot"],
			["assistant", expect.any(String)],
			["user", "also this"],
			["assistant", "answer"],
		]);
	});

	it(`holds a stopped Subagent's slot until its Run ends`, async () => {
		const [parent] = await db
			.insert(schema.conversation)
			.values({ userId, agentId: "faux", title: "t" })
			.returning();
		const children = await db
			.insert(schema.conversation)
			.values(
				Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => ({
					userId,
					parentId: parent.id,
					// as if their Runs were underway
					status: i < MAX_SUBAGENTS ? ("running" as const) : ("idle" as const),
				})),
			)
			.returning();
		await db.insert(schema.subagent).values(
			children.map((c, i) => ({
				conversationId: c.id,
				parentId: parent.id,
				toolCallId: "call",
				number: i + 1,
				brief: "b",
				outcome: i < MAX_SUBAGENTS ? ("running" as const) : ("queued" as const),
			})),
		);
		const waiting = children[MAX_SUBAGENTS];
		await db.insert(schema.inbox).values({
			conversationId: waiting.id,
			message: { role: "user", content: "b", timestamp: Date.now() },
			model: "faux/faux-1",
			thinkingLevel: "off",
			wake: true,
		});
		await runs.stopSubagents(parent.id, [1]);
		// its Run has yet to end, so the slot is still taken
		expect(await runs.ensureRun(waiting.id)).toBe(false);
	});

	it("stops and drops, on retry, the Subagents the failed reply started", async () => {
		script({
			parent: [
				fauxAssistantMessage(
					fauxToolCall("subagent", { tasks: [{ brief: "find pi" }] }),
				),
				fauxAssistantMessage("half", {
					stopReason: "error",
					errorMessage: "boom",
				}),
				fauxAssistantMessage("retried"),
			],
			sub: [hang],
		});
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "research",
		});
		await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "failed" && v.subagents[0]?.outcome === "running",
		);
		await conversations.retry(userId, id);
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle",
		);
		expect(view?.messages.map((m) => m.message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(view?.subagents).toEqual([]);
	});

	it("starts one Run for two wake inputs that arrive together, and delivers both", async () => {
		faux.setResponses([
			fauxAssistantMessage("Both"),
			fauxAssistantMessage("T"),
		]);
		const [{ id }] = await db
			.insert(schema.conversation)
			.values({ userId, agentId: "faux" })
			.returning({ id: schema.conversation.id });
		await db.insert(schema.inbox).values(
			["one", "two"].map((content) => ({
				conversationId: id,
				message: { role: "user", content, timestamp: Date.now() },
				model: "faux/faux-1",
				thinkingLevel: "off",
				wake: true,
			})),
		);
		const started = await Promise.all([runs.ensureRun(id), runs.ensureRun(id)]);
		expect(started.filter(Boolean)).toHaveLength(1);
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.title === "T",
		);
		expect(
			view?.messages.map((m) => [m.message.role, m.message.content]),
		).toMatchObject([
			["user", "one"],
			["user", "two"],
			["assistant", [{ type: "text", text: "Both" }]],
		]);
	});

	it("delivers a message sent while running at the next step boundary, into the model's context", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response(JSON.stringify({ results: [] })),
		);
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
					m.role === "user" && typeof m.content === "string" ? [m.content] : [],
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

	it("hides a Conversation from everyone but its owner", async () => {
		faux.setResponses([fauxAssistantMessage("hi"), fauxAssistantMessage("T")]);
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "hi",
		});
		await db
			.insert(schema.user)
			.values({ id: "admin", name: "A", email: "a@x.io", role: "admin" });
		expect(await conversations.get("admin", id)).toBeUndefined();
		expect(await conversations.list("admin")).toEqual([]);
		expect(
			await conversations.subscribe("admin", id, new AbortController().signal),
		).toBeUndefined();
	});

	// last: it swaps the worker for one that notices stalled runs quickly
	it("works on several Runs at once", async () => {
		await stopWorker();
		stopWorker = await startAgentWorker(config.get);
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
			await conversations.send(userId, { agentId: "faux", text: "a" }),
			await conversations.send(userId, { agentId: "faux", text: "b" }),
		];
		// both replies are underway before either may finish
		await waitFor(
			async () => replying,
			(n) => n === 2,
		);
		release();
		for (const id of ids)
			await waitFor(
				() => conversations.get(userId, id),
				(v) => v?.status === "idle" && v.title === "T",
			);
		await stopWorker();
		stopWorker = await startAgentWorker(config.get, {
			concurrency: 1,
		});
	});

	it("queues again, when the worker starts, a Run left running without a job", async () => {
		await stopWorker();
		faux.setResponses([
			fauxAssistantMessage("back"),
			fauxAssistantMessage("T"),
		]);
		// as after a crash between saving a Run's start and queueing it
		const [{ id }] = await db
			.insert(schema.conversation)
			.values({ userId, agentId: "faux", status: "running" })
			.returning({ id: schema.conversation.id });
		await db.insert(schema.inbox).values({
			conversationId: id,
			message: { role: "user", content: "hi", timestamp: Date.now() },
			model: "faux/faux-1",
			thinkingLevel: "off",
			wake: true,
		});
		stopWorker = await startAgentWorker(config.get, {
			concurrency: 1,
		});
		const view = await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.title === "T",
		);
		expect(view?.messages.map((m) => m.message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("queues a Run once when the worker's startup requeue races the start that saved it", async () => {
		await stopWorker();
		faux.setResponses([
			fauxAssistantMessage("back"),
			fauxAssistantMessage("T"),
		]);
		// a Run's start is saved, but not yet queued
		const [{ id }] = await db
			.insert(schema.conversation)
			.values({ userId, agentId: "faux", status: "running", jobId: "run-1" })
			.returning({ id: schema.conversation.id });
		await db.insert(schema.inbox).values({
			conversationId: id,
			message: { role: "user", content: "hi", timestamp: Date.now() },
			model: "faux/faux-1",
			thinkingLevel: "off",
			wake: true,
		});
		stopWorker = await startAgentWorker(config.get, {
			concurrency: 1,
		});
		// the start queues it after the worker's requeue did
		await runs.enqueue(id);
		await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "idle" && v.title === "T",
		);
		// a second job would find nothing to reply to and fail the Conversation
		await new Promise((r) => setTimeout(r, 500));
		expect((await conversations.get(userId, id))?.status).toBe("idle");
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
		const id = await conversations.send(userId, {
			agentId: "faux",
			text: "hi",
		});
		await waitFor(async () => picked, Boolean);
		await crashing.close(true);

		stopWorker = await startAgentWorker(config.get, {
			stalledInterval: 200,
			concurrency: 1,
		});
		await waitFor(
			() => conversations.get(userId, id),
			(v) => v?.status === "failed",
		);
		await conversations.retry(userId, id);
		const view = await waitFor(
			() => conversations.get(userId, id),
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
