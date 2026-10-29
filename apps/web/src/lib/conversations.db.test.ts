import {
	type AssistantMessage,
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
const { startAgentWorker } = await import("../../../worker/src/run.ts");
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
		stopWorker = await startAgentWorker(config.get, url as string);
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
		// the worker runs one job at a time, so the second Conversation waits
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

	it("hands a task to a Subagent that starts fresh and only returns its final answer", async () => {
		const seen: { messages: { role: string; toolsAdded?: unknown }[] }[] = [];
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("subagent", { tasks: [{ brief: "find pi" }] }),
			),
			(context) => {
				seen.push(context as (typeof seen)[number]);
				return fauxAssistantMessage("pi is at pi.dev");
			},
			fauxAssistantMessage("Done"),
			fauxAssistantMessage("T"),
		]);
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
		]);
		const result = view?.messages[2].message as ToolResultMessage;
		expect(JSON.stringify(result.content)).toContain("pi is at pi.dev");
		// its whole process is kept with the Turn
		expect(result.details).toMatchObject({
			subagents: [
				{
					brief: "find pi",
					messages: [{ role: "user" }, { role: "assistant" }],
				},
			],
		});
	});

	it("ends a Subagent at its step limit with its partial result", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response(JSON.stringify({ results: [] })),
		);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("subagent", { tasks: [{ brief: "dig" }] }),
			),
			...Array.from({ length: MAX_SUBAGENT_STEPS }, (_, i) =>
				fauxAssistantMessage([
					fauxText(`step ${i + 1}`),
					fauxToolCall("search", { query: "more" }),
				]),
			),
			fauxAssistantMessage("Done"),
			fauxAssistantMessage("T"),
		]);
		const id = await conversations.sendMessage(userId, {
			agentId: "faux",
			text: "dig deep",
		});
		const view = await waitFor(
			() => conversations.getConversation(userId, id),
			(v) => v?.title === "T",
		);
		const result = view?.messages[2].message as ToolResultMessage;
		expect(JSON.stringify(result.content)).toContain(
			`step ${MAX_SUBAGENT_STEPS}`,
		);
		expect(JSON.stringify(result.content)).toContain("step limit");
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
