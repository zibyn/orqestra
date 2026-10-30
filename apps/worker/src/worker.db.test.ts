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

// Smoke tests of the assembled worker: the runtime replying through the real @orqestra/conversations
// (lifecycle scenarios are tested there, runtime ones in src/runtime): needs TEST_DATABASE_URL, which src/test-env.ts sets up
const url = process.env.TEST_DATABASE_URL;
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { config } = await import("@orqestra/config/live");
const { createConversations } = await import("@orqestra/conversations");
const { startAgentWorker } = await import("./worker.ts");
const { MAX_SUBAGENT_STEPS } = await import("./runtime/tools.ts");

const conversations = createConversations({ config: config.current });
const faux = fauxProvider({
	provider: "faux",
	models: [{ id: "faux-1", reasoning: true }],
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

describe.skipIf(!url)(
	"Runs replied by the runtime (Postgres + faux provider)",
	() => {
		let stopWorker: () => Promise<void>;

		beforeAll(async () => {
			const loaded = await config.current();
			loaded.registry.registerProvider(faux.provider);
			loaded.models.push(...faux.models);
			loaded.agents.push(fauxAgent);
			loaded.tools.search = {
				provider: "tavily",
				apiKey: "k",
				baseUrl: "https://api.tavily.com",
			};
			// faux replies are one shared queue, so runs go one at a time
			stopWorker = await startAgentWorker(config.current, {
				concurrency: 1,
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
	},
);
