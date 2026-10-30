import { describe, expect, it } from "bun:test";
import {
	type AssistantMessage,
	type Context,
	createModels,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Message,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	type AgentDefinition,
	type OrqestraConfig,
	resolveTurn,
} from "@orqestra/config";
import type { Transcript, Turn } from "@orqestra/conversations";
import { memoryRun } from "@orqestra/conversations/testing";
import { openToolbox } from "@orqestra/tools";
import { runAgent } from "./index.ts";
import { MAX_SUBAGENT_STEPS } from "./tools.ts";

// The runtime replying to a Run kept in memory, against pi's faux provider: no Postgres, no BullMQ
const faux = fauxProvider({
	provider: "faux",
	models: [
		{ id: "faux-1", reasoning: true },
		{ id: "faux-small", contextWindow: 2000 },
	],
	tokensPerSecond: 400,
});
const models = createModels();
models.setProvider(faux.provider);
const streamSimple: OrqestraConfig["streamSimple"] =
	models.streamSimple.bind(models);

const agent = (fields: Partial<AgentDefinition>): AgentDefinition => ({
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
	...fields,
});
const config = {
	agents: [
		agent({}),
		// a tiny context window so a short history already needs compaction
		agent({
			id: "small",
			instructions: "",
			models: ["faux/faux-small"],
			defaultModel: "faux/faux-small",
			compaction: { reserveTokens: 1000, keepRecentTokens: 50 },
		}),
	],
	models: faux.models,
	tools: {
		search: {
			provider: "tavily" as const,
			apiKey: "k",
			baseUrl: "https://api.tavily.com",
		},
	},
	mcpServers: {},
};
const turn = (agentId = "faux") => resolveTurn(config, agentId) as Turn;

// Search answers with `results`
const deps = (results: unknown[] = []) => ({
	config,
	streamSimple,
	openToolbox: ((services, allowed, options) =>
		openToolbox(services, allowed, {
			...options,
			fetch: (async () =>
				new Response(JSON.stringify({ results }))) as unknown as typeof fetch,
		})) as typeof openToolbox,
});

const user = (content: string): Message => ({
	role: "user",
	content,
	timestamp: 1,
});
const transcript = (...messages: Message[]): Transcript => ({
	messages: messages.map((message, i) => ({
		id: i + 1,
		message,
		createdAt: new Date(2026, 0, 1, 0, 0, i),
	})),
});

// each request takes the next reply meant for it, told apart by whether it asks for a title
function script(replies: FauxResponseStep[], title = "T") {
	const queues = { reply: [...replies], title: [fauxAssistantMessage(title)] };
	faux.setResponses(
		Array.from({ length: replies.length + 1 }, () => (context, ...rest) => {
			const queue = JSON.stringify(context).includes("Write a title")
				? queues.title
				: queues.reply;
			const next = queue.shift();
			if (!next) throw new Error("No faux reply left");
			return typeof next === "function" ? next(context, ...rest) : next;
		}),
	);
}
const roles = (messages: Message[]) => messages.map((m) => m.role);

describe("runAgent", () => {
	it("streams a reply, then saves it and a title", async () => {
		script(
			[
				fauxAssistantMessage([
					fauxThinking("let me think"),
					fauxText("Hello there"),
				]),
			],
			"A greeting",
		);
		const m = memoryRun({ transcript: transcript(user("hi")), turn: turn() });
		await runAgent(m.run, deps());

		expect(m.streamed[0]).toEqual({ type: "start" });
		const deltas = (kind: string) =>
			m.streamed
				.map((e) => (e.type === "delta" && e.kind === kind ? e.delta : ""))
				.join("");
		expect(deltas("thinking")).toBe("let me think");
		expect(deltas("text")).toBe("Hello there");
		expect(m.saved).toHaveLength(1);
		expect((m.saved[0] as AssistantMessage).content).toMatchObject([
			{ type: "thinking", thinking: "let me think" },
			{ type: "text", text: "Hello there" },
		]);
		expect(m.over).toBe(true);
		expect(m.titles).toEqual(["A greeting"]);
	});

	it("titles only the first Turn that produced a reply, and not a renamed Conversation", async () => {
		script([fauxAssistantMessage("again")]);
		const later = memoryRun({
			transcript: transcript(user("hi"), fauxAssistantMessage("yo"), user("x")),
			turn: turn(),
		});
		await runAgent(later.run, deps());
		expect(later.titles).toEqual([]);

		let asked = false;
		faux.setResponses([
			fauxAssistantMessage("hello"),
			() => {
				asked = true;
				return fauxAssistantMessage("T");
			},
		]);
		const renamed = memoryRun({
			transcript: transcript(user("hi")),
			turn: turn(),
			renamed: true,
		});
		await runAgent(renamed.run, deps());
		expect(asked).toBe(false);
	});

	it("stops generating when asked and keeps what was generated", async () => {
		const long = "word ".repeat(2000);
		script([fauxAssistantMessage(long)]);
		const m = memoryRun({
			transcript: transcript(user("write a lot")),
			turn: turn(),
		});
		const stream = m.run.stream;
		m.run.stream = async (event) => {
			if (event.type === "delta") m.stop();
			await stream(event);
		};
		await runAgent(m.run, deps());

		const reply = m.saved[0] as AssistantMessage;
		expect(reply.stopReason).toBe("aborted");
		expect(JSON.stringify(reply.content).length).toBeLessThan(long.length);
		expect(m.over).toBe(true);
		// a stopped first reply still names the Conversation
		expect(m.titles).toEqual(["T"]);
	});

	it("compacts a long history before the turn", async () => {
		const old = fauxAssistantMessage("b".repeat(2000));
		old.usage.totalTokens = 1500; // what the provider reported for that turn
		let seen = "";
		script([
			fauxAssistantMessage("SUMMARY OF EARLIER"),
			(ctx) => {
				seen = JSON.stringify(ctx.messages);
				return fauxAssistantMessage("ok");
			},
		]);
		const m = memoryRun({
			transcript: transcript(user("a".repeat(4000)), old, user("next?")),
			turn: turn("small"),
		});
		await runAgent(m.run, deps());

		expect(m.compactions).toEqual([
			{
				summary: "SUMMARY OF EARLIER",
				firstKeptId: 3,
				tokensBefore: expect.any(Number),
			},
		]);
		expect(seen).toContain("SUMMARY OF EARLIER");
		expect(seen).not.toContain("aaaa");
		expect(roles(m.saved)).toEqual(["assistant"]);
	});

	it("saves a Tool call and its result as part of the Turn", async () => {
		script([
			fauxAssistantMessage(fauxToolCall("search", { query: "pi", count: 1 })),
			fauxAssistantMessage("Pi is an agent"),
		]);
		const m = memoryRun({
			transcript: transcript(user("what is pi?")),
			turn: turn(),
		});
		await runAgent(
			m.run,
			deps([{ title: "Pi", url: "https://pi.dev", content: "An agent" }]),
		);

		expect(roles(m.saved)).toEqual(["assistant", "toolResult", "assistant"]);
		const result = m.saved[1] as ToolResultMessage;
		expect(result.toolName).toBe("search");
		expect(JSON.stringify(result.content)).toContain("https://pi.dev");
	});

	it("gives a Subagent at its step limit one last request without Tools for its answer", async () => {
		let first: Context | undefined;
		let last: Context | undefined;
		script([
			(context) => {
				first = context;
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
		]);
		const m = memoryRun({
			transcript: transcript(user("dig")),
			turn: turn(),
			isSubagent: true,
		});
		await runAgent(m.run, deps());

		// a Subagent cannot start Subagents in turn
		const offered = JSON.stringify(
			(first?.messages[0] as { toolsAdded?: unknown }).toolsAdded,
		);
		expect(offered).toContain("search");
		expect(offered).not.toContain("subagent");
		expect(JSON.stringify(last?.messages)).toContain("step limit");
		expect(m.outcomes).toEqual([
			{ outcome: "partial", result: "what I found" },
		]);
		expect(m.titles).toEqual([]);
	});

	it("delivers a message sent while running at the next step boundary, into the model's context", async () => {
		let seen: string[] = [];
		const m = memoryRun({
			transcript: transcript(user("first")),
			turn: turn(),
		});
		script([
			() => {
				m.push(user("also this"));
				return fauxAssistantMessage(fauxToolCall("search", { query: "x" }));
			},
			(context) => {
				seen = context.messages.flatMap((msg) =>
					msg.role === "user" && typeof msg.content === "string"
						? [msg.content]
						: [],
				);
				return fauxAssistantMessage("Got both");
			},
		]);
		await runAgent(m.run, deps());

		expect(seen).toEqual(["first", "also this"]);
		expect(roles(m.saved)).toEqual(["assistant", "toolResult", "assistant"]);
		expect(m.over).toBe(true);
	});
});
