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
import { SpanStatusCode } from "@opentelemetry/api";
import {
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
	TracerProvider,
} from "@opentelemetry/sdk-trace";
import { type AgentDefinition, resolveTurn } from "@orqestra/agents";
import type { Transcript, Turn } from "@orqestra/conversations";
import { DEFAULT_LIMITS } from "@orqestra/conversations";
import { messageText } from "@orqestra/conversations/shared";
import { memoryRun as memoryRunOf } from "@orqestra/conversations/testing";
import { fakeMcpServer, memoryConnections } from "@orqestra/mcp/testing";
import { zip } from "@orqestra/skills/test-zip";
import { memoryOrrery, memoryStore } from "@orqestra/tools/testing";
import { otelTelemetry, tracing } from "../tracing.ts";
import { runAgent } from "./index.ts";
import { openToolbox } from "./toolbox.ts";
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
// every request alike, whatever it is for, on the Run's metered streaming
const memoryRun = (options: Parameters<typeof memoryRunOf>[0]) =>
	memoryRunOf({ streamSimple: models.streamSimple.bind(models), ...options });

const agent = (fields: Partial<AgentDefinition>): AgentDefinition => ({
	id: "faux",
	name: "Faux",
	description: "test Agent",
	instructions: "You are a test.",
	default: false,
	pickable: true,
	tools: ["search", "scrape"],
	skills: [],
	...fields,
});
const config = {
	agents: [agent({}), agent({ id: "small", instructions: "" })],
	models: faux.models,
	tools: {
		search: {
			provider: "tavily" as const,
			apiKey: "k",
			baseUrl: "https://api.tavily.com",
		},
	},
	mcpServers: {},
	allMcpServers: {},
	skills: {},
	// small budgets, so a short history on faux-small's tiny context window already needs compaction
	limits: {
		...DEFAULT_LIMITS,
		compactionReserveTokens: 1000,
		compactionKeepRecentTokens: 50,
	},
};
const turn = (agentId = "faux", model?: string) =>
	resolveTurn(config, agentId, { model }) as Turn;

// Search answers with `results`
const deps = (results: unknown[] = []) => ({
	config,
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

	it("titles a later Turn of a Conversation still without a title, and not one titled or renamed", async () => {
		script([fauxAssistantMessage("again")]);
		const later = memoryRun({
			transcript: transcript(user("hi"), fauxAssistantMessage("yo"), user("x")),
			turn: turn(),
		});
		await runAgent(later.run, deps());
		expect(later.titles).toEqual(["T"]);

		let asked = false;
		faux.setResponses([
			fauxAssistantMessage("hello"),
			() => {
				asked = true;
				return fauxAssistantMessage("T");
			},
		]);
		const titled = memoryRun({
			transcript: transcript(user("hi")),
			turn: turn(),
			titled: true,
		});
		await runAgent(titled.run, deps());
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
			turn: turn("small", "faux/faux-small"),
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

		// a Subagent at the deepest level cannot start Subagents in turn
		const offered = JSON.stringify(
			(first?.messages[0] as { toolsAdded?: unknown }).toolsAdded,
		);
		expect(offered).toContain("search");
		expect(offered).not.toContain("subagent");
		// nor ask the User: only the top-level Agent talks to them
		expect(offered).not.toContain("ask_user");
		// nor set a Timer
		expect(offered).not.toContain("_timer");
		// nor draft a Scheduled Task
		expect(offered).not.toContain("draft_scheduled_task");
		expect(JSON.stringify(last?.messages)).toContain("step limit");
		expect(m.outcomes).toEqual([
			{ outcome: "partial", result: "what I found" },
		]);
		expect(m.titles).toEqual([]);
	});

	it("gives a Subagent above the deepest level the Subagent Tools", async () => {
		let first: Context | undefined;
		script([
			(context) => {
				first = context;
				return fauxAssistantMessage("done");
			},
		]);
		const unused = async (): Promise<never> => {
			throw new Error("unused");
		};
		const m = memoryRun({
			transcript: transcript(user("lead")),
			turn: turn(),
			isSubagent: true,
			subagents: { start: unused, message: unused, stop: unused },
		});
		await runAgent(m.run, deps());

		expect(
			JSON.stringify(
				(first?.messages[0] as { toolsAdded?: unknown }).toolsAdded,
			),
		).toContain("subagent_message");
	});

	describe("an Unattended Run", () => {
		const searching = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				fauxAssistantMessage([
					fauxText(`step ${i + 1}`),
					fauxToolCall("search", { query: "more" }),
				]),
			);
		const limited = {
			...deps(),
			config: {
				...config,
				limits: { ...DEFAULT_LIMITS, unattendedMaxSteps: 3 },
			},
		};

		it("makes its last request at the Limits' step cap without Tools, and ends partial", async () => {
			let last: Context | undefined;
			script([
				...searching(2),
				(context) => {
					last = context;
					return fauxAssistantMessage("what I found");
				},
			]);
			const m = memoryRun({
				transcript: transcript(user("check the build")),
				turn: turn(),
				unattended: true,
			});
			await runAgent(m.run, limited);

			expect(JSON.stringify(last?.messages)).toContain("step limit");
			expect(last?.tools ?? []).toEqual([]);
			expect(m.outcomes).toEqual([
				{ outcome: "partial", result: "what I found" },
			]);
			expect(m.over).toBe(true);
		});

		it("ends partial when it runs out of time, keeping what was generated", async () => {
			const long = "word ".repeat(2000);
			script([fauxAssistantMessage(long)]);
			const m = memoryRun({
				transcript: transcript(user("write a lot")),
				turn: turn(),
				unattended: true,
			});
			const stream = m.run.stream;
			m.run.stream = async (event) => {
				if (event.type === "delta") m.timeOut();
				await stream(event);
			};
			await runAgent(m.run, limited);

			expect((m.saved[0] as AssistantMessage).stopReason).toBe("aborted");
			expect(m.outcomes).toEqual([
				{ outcome: "partial", result: expect.stringContaining("word") },
			]);
		});

		it("is no limit on an attended Run", async () => {
			script([...searching(4), fauxAssistantMessage("all done")]);
			const m = memoryRun({
				transcript: transcript(user("dig")),
				turn: turn(),
			});
			await runAgent(m.run, limited);

			expect(
				m.saved.filter((s) => s.role === "assistant").map(messageText),
			).toEqual(["step 1", "step 2", "step 3", "step 4", "all done"]);
			expect(m.outcomes).toEqual([undefined]);
		});
	});

	it("ends the Run with the Question the Agent asks the User, titled from it", async () => {
		script(
			[
				fauxAssistantMessage(
					fauxToolCall("ask_user", {
						question: "Which pi?",
						suggestions: ["The agent", "The number"],
					}),
				),
			],
			"Pi",
		);
		const m = memoryRun({ transcript: transcript(user("pi?")), turn: turn() });
		await runAgent(m.run, deps());

		expect(roles(m.saved)).toEqual(["assistant", "toolResult"]);
		expect((m.saved[1] as ToolResultMessage).isError).toBe(false);
		expect(m.questions).toEqual([true]);
		expect(m.over).toBe(true);
		expect(m.titles).toEqual(["Pi"]);
	});

	it("sets a Timer for the Agent from a minute to a day ahead, and cancels it", async () => {
		script([
			fauxAssistantMessage([
				fauxToolCall("set_timer", { delay: 30, note: "too soon" }),
				fauxToolCall("set_timer", { delay: 600, note: "check the build" }),
			]),
			fauxAssistantMessage("I'll check back in 10 minutes"),
		]);
		const m = memoryRun({
			transcript: transcript(user("build")),
			turn: turn(),
		});
		await runAgent(m.run, deps());
		const results = m.saved.filter(
			(s): s is ToolResultMessage => s.role === "toolResult",
		);
		expect(results.map((r) => r.isError)).toEqual([true, false]);
		expect(m.timer).toEqual({ delay: 600, note: "check the build" });

		script([
			fauxAssistantMessage(fauxToolCall("cancel_timer", {})),
			fauxAssistantMessage("Cancelled"),
		]);
		await runAgent(m.run, deps());
		expect(m.timer).toBeUndefined();
	});

	it("drafts a Scheduled Task for the User to create, refusing an invalid or too frequent schedule, and carries on, Unattended too", async () => {
		const draft = (
			schedule: Record<string, string | number>,
			ends_at?: string,
		) =>
			fauxToolCall("draft_scheduled_task", {
				name: "Build report",
				prompt: "Report on the nightly build",
				schedule,
				...(ends_at ? { ends_at } : {}),
			});
		script([
			fauxAssistantMessage([
				draft({ kind: "cron", expr: "not cron" }),
				// DEFAULT_LIMITS: an hour apart at least
				draft({ kind: "every", seconds: 600 }),
				draft({ kind: "once", at: "2020-01-01T09:00:00Z" }),
				draft({ kind: "cron", expr: "0 9 * * *" }, "2020-01-01T00:00:00Z"),
				draft({ kind: "cron", expr: "0 9 * * 1-5" }),
			]),
			fauxAssistantMessage("Here is the draft"),
		]);
		const m = memoryRun({
			transcript: transcript(user("every weekday at 9")),
			turn: turn(),
			unattended: true,
		});
		await runAgent(m.run, deps());

		const results = m.saved.filter(
			(s): s is ToolResultMessage => s.role === "toolResult",
		);
		expect(results.map((r) => r.isError)).toEqual([
			true,
			true,
			true,
			true,
			false,
		]);
		expect(messageText(results[1] as unknown as Message)).toContain(
			"3600 seconds apart",
		);
		expect(messageText(results[4] as unknown as Message)).toContain(
			"not created it yet",
		);
		// the Run goes on past the draft
		expect(messageText(m.saved.at(-1) as Message)).toBe("Here is the draft");
	});

	it("refuses a second Question in the same Turn", async () => {
		script([
			fauxAssistantMessage([
				fauxToolCall("ask_user", { question: "Which pi?" }),
				fauxToolCall("ask_user", { question: "And why?" }),
			]),
		]);
		const m = memoryRun({ transcript: transcript(user("pi?")), turn: turn() });
		await runAgent(m.run, deps());

		const results = m.saved.filter(
			(s): s is ToolResultMessage => s.role === "toolResult",
		);
		expect(results.map((r) => r.isError)).toEqual([false, true]);
		expect(m.questions).toEqual([true]);
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

	it("does not fail the Run when two MCP Tools end up with the same name", async () => {
		// an MCP Server whose Tools "a.b" and "a_b" both become "s__a_b"; each echoes which one ran
		const fake = fakeMcpServer({
			tools: ["a.b", "a_b"].map((name) => ({
				name,
				inputSchema: { type: "object" as const },
				call: () => ({
					content: [{ type: "text" as const, text: `ran ${name}` }],
				}),
			})),
		});
		const mcpConfig = {
			...config,
			agents: [agent({ id: "mcp", tools: ["mcp:s"] })],
			mcpServers: {
				s: { name: "S", url: "https://s.example.com/mcp", headers: {} },
			},
		};
		let offered: string[] = [];
		script([
			(context) => {
				offered = context.messages.flatMap(
					(msg) =>
						(msg as { toolsAdded?: { name: string }[] }).toolsAdded?.map(
							(t) => t.name,
						) ?? [],
				);
				// a Provider refuses a request that names a Tool twice
				if (new Set(offered).size < offered.length)
					throw new Error("duplicate Tool name");
				return fauxAssistantMessage(fauxToolCall("s__a_b", {}));
			},
			fauxAssistantMessage("Done"),
		]);
		const m = memoryRun({
			transcript: transcript(user("use it")),
			turn: resolveTurn(mcpConfig, "mcp") as Turn,
		});
		await runAgent(m.run, {
			config: mcpConfig,
			openToolbox: ((services, allowed, options) =>
				openToolbox(services, allowed, {
					...options,
					fetch: fake.fetch,
				})) as typeof openToolbox,
		});

		expect(offered.filter((n) => n.startsWith("s__"))).toEqual(["s__a_b"]);
		expect(roles(m.saved)).toEqual(["assistant", "toolResult", "assistant"]);
		expect(JSON.stringify(m.saved[1])).toContain("ran a.b");
		expect(m.over).toBe(true);
	});

	it("gives a Subagent the Tools of a per-User OAuth MCP Server its User connected to, with their token", async () => {
		const fake = fakeMcpServer({
			tools: [{ name: "echo", inputSchema: { type: "object" } }],
		});
		const oauthConfig = {
			...config,
			agents: [agent({ id: "gh", tools: ["mcp:gh"] })],
			mcpServers: {
				gh: {
					name: "GH",
					url: "https://gh.example.com/mcp",
					auth: "oauth" as const,
					headers: {},
				},
			},
		};
		const connections = memoryConnections();
		// the Subagent's Run is its top-level Conversation's User's
		const m = memoryRun({
			transcript: transcript(user("use it")),
			turn: resolveTurn(oauthConfig, "gh") as Turn,
			isSubagent: true,
			connections,
		});
		await connections.saveConnection(m.run.userId, "gh", {
			tokens: { access_token: "ada-token", token_type: "Bearer" },
			issuer: "https://as.example.com",
		});
		let offered = "";
		script([
			(context) => {
				offered = JSON.stringify(context.messages);
				return fauxAssistantMessage("Done");
			},
		]);
		await runAgent(m.run, {
			config: oauthConfig,
			openToolbox: ((services, allowed, options) =>
				openToolbox(services, allowed, {
					...options,
					fetch: fake.fetch,
				})) as typeof openToolbox,
		});

		expect(offered).toContain("gh__echo");
		expect(fake.requests[0].headers.get("authorization")).toBe(
			"Bearer ada-token",
		);
	});
});

describe("runAgent with Skills", () => {
	const files: Record<number, Record<string, string>> = {
		1: { "SKILL.md": "# PDF v1", "scripts/x.py": "print(1)" },
		2: { "SKILL.md": "# PDF v2" },
		3: { "SKILL.md": "# Manual" },
	};
	const provider = { url: "http://o", token: "t", cpu: 2, memory: 2 ** 31 };
	const skillConfig = () => ({
		...config,
		agents: [
			agent({ id: "skilled", tools: [], skills: ["pdf", "manual", "gone"] }),
		],
		skills: {
			pdf: {
				versionId: 1,
				description: "Fill & read <PDF> forms",
				disableModelInvocation: false,
			},
			manual: {
				versionId: 3,
				description: "Only on request",
				disableModelInvocation: true,
			},
		},
		sandboxProvider: provider as typeof provider | undefined,
	});
	// a version's files as the database has them; `current.pdf` plays an Admin uploading a new version of pdf
	const current = { pdf: 1 };
	const skillFiles = async (versionId: number) =>
		Object.entries(files[versionId === 1 ? current.pdf : versionId]).map(
			([path, text]) => ({ path, content: Buffer.from(text) }),
		);
	const setup = (
		o: ReturnType<typeof memoryOrrery>,
		cfg: ReturnType<typeof skillConfig> = skillConfig(),
	) => ({
		m: memoryRun({
			transcript: transcript(user("help")),
			turn: resolveTurn(cfg, "skilled") as Turn,
			skillFiles,
			orrery: o.client,
			// the prompt holds only the Agent's instructions and its Skills
			memoryOff: true,
		}),
		deps: { config: cfg, openToolbox },
	});
	// what bash does for these commands
	const shell = (command: string, fs: Map<string, Uint8Array<ArrayBuffer>>) => {
		if (command.includes("rm -rf /workspace/.skills"))
			for (const path of fs.keys())
				if (path.startsWith(".skills/")) fs.delete(path);
		return { stdout: command === "echo hi" ? "hi\n" : "" };
	};
	const toolResults = (m: ReturnType<typeof memoryRun>) =>
		m.saved.filter((s): s is ToolResultMessage => s.role === "toolResult");
	const resultText = (r: ToolResultMessage) =>
		r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	// pi carries the prompt in the transcript's first, system, message
	const systemPrompt = (c?: Context) =>
		(c?.messages[0] as unknown as { role: string; content: string }).content;
	// besides the Subagent, Question and Timer Tools every top-level Agent has
	const offeredTools = (c?: Context) =>
		(
			c?.messages.flatMap(
				(msg) =>
					(msg as { toolsAdded?: { name: string }[] }).toolsAdded?.map(
						(t) => t.name,
					) ?? [],
			) ?? []
		).filter(
			(n) =>
				!n.startsWith("subagent") &&
				n !== "ask_user" &&
				!n.endsWith("_timer") &&
				n !== "draft_scheduled_task",
		);

	it("lists the Skills the model may invoke in the prompt, and offers read, bash and attach", async () => {
		let context: Context | undefined;
		script([
			(c) => {
				context = c;
				return fauxAssistantMessage("ok");
			},
		]);
		const o = memoryOrrery();
		const { m, deps } = setup(o);
		await runAgent(m.run, deps);

		const prompt = systemPrompt(context);
		expect(prompt.startsWith("You are a test.")).toBe(true);
		expect(prompt).toContain("<name>pdf</name>");
		expect(prompt).toContain(
			"<description>Fill &amp; read &lt;PDF&gt; forms</description>",
		);
		expect(prompt).toContain(
			"<location>/workspace/.skills/pdf/SKILL.md</location>",
		);
		expect(prompt).not.toContain("manual");
		expect(offeredTools(context)).toEqual(["read", "bash", "attach"]);
		// nothing is created until a Tool needs it
		expect(o.calls).toEqual([]);
	});

	it("offers no Sandbox, Tools or Skill list without a Sandbox Provider", async () => {
		let context: Context | undefined;
		script([
			(c) => {
				context = c;
				return fauxAssistantMessage("ok");
			},
		]);
		const { m, deps } = setup(memoryOrrery(), {
			...skillConfig(),
			sandboxProvider: undefined,
		});
		await runAgent(m.run, deps);
		expect(systemPrompt(context)).toBe("You are a test.");
		expect(offeredTools(context)).toEqual([]);
	});

	it("offers the Sandbox without a Skill list, and writes no Skills, when no Skill is available", async () => {
		const contexts: Context[] = [];
		script([
			(c) => {
				contexts.push(c);
				return fauxAssistantMessage(
					fauxToolCall("bash", { command: "echo hi" }),
				);
			},
			(c) => {
				contexts.push(c);
				return fauxAssistantMessage("ok");
			},
		]);
		const o = memoryOrrery();
		const { m, deps } = setup(o, {
			...skillConfig(),
			agents: [agent({ id: "skilled", tools: [], skills: ["gone"] })],
		});
		await runAgent(m.run, deps);
		expect(systemPrompt(contexts[0])).toBe("You are a test.");
		expect(offeredTools(contexts[0])).toEqual(["read", "bash", "attach"]);
		expect(o.calls.filter((c) => c.startsWith("createSandbox"))).toHaveLength(
			1,
		);
		expect(o.calls.some((c) => c.startsWith("uploadArchive"))).toBe(false);
	});

	it("creates the Sandbox when a Tool first needs it, writes the Skills, and runs commands in it", async () => {
		script([
			fauxAssistantMessage(
				fauxToolCall("read", { path: "/workspace/.skills/pdf/SKILL.md" }),
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" })),
			fauxAssistantMessage("done"),
		]);
		const o = memoryOrrery({ exec: shell });
		const { m, deps } = setup(o);
		await runAgent(m.run, deps);

		const [read, bash] = toolResults(m);
		expect(read.isError).toBe(false);
		expect(resultText(read)).toBe("# PDF v1");
		expect(resultText(bash)).toContain("Exit code: 0");
		expect(resultText(bash)).toContain("hi\n");
		const id = m.sandboxId as string;
		// every Skill the Agent may use is written, the one the model may not invoke too
		expect([...o.files(id).keys()].sort()).toEqual([
			".skills/manual/SKILL.md",
			".skills/pdf/SKILL.md",
			".skills/pdf/scripts/x.py",
		]);
		expect(o.calls.filter((c) => c.startsWith("createSandbox"))).toHaveLength(
			1,
		);
		expect(o.calls.filter((c) => c.startsWith("uploadArchive"))).toHaveLength(
			1,
		);
	});

	it("writes the current Skills again after starting a Sandbox Idle Stop stopped", async () => {
		const o = memoryOrrery({ exec: shell });
		const { m, deps } = setup(o);
		script([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" })),
			() => {
				// stopped between two steps, and the Admin uploaded a new version meanwhile
				o.stop(m.sandboxId as string);
				current.pdf = 2;
				return fauxAssistantMessage(
					fauxToolCall("read", { path: ".skills/pdf/SKILL.md" }),
				);
			},
			fauxAssistantMessage("done"),
		]);
		try {
			await runAgent(m.run, deps);
		} finally {
			current.pdf = 1;
		}

		expect(resultText(toolResults(m)[1])).toBe("# PDF v2");
		expect(o.calls).toContain(`startSandbox ${m.sandboxId}`);
		// the old version's script is gone
		expect(o.files(m.sandboxId as string).has(".skills/pdf/scripts/x.py")).toBe(
			false,
		);
	});

	it("gives stdout, stderr and the exit code, cutting long output and saying so", async () => {
		script([
			fauxAssistantMessage(fauxToolCall("bash", { command: "noisy" })),
			fauxAssistantMessage(fauxToolCall("bash", { command: "killed" })),
			fauxAssistantMessage("done"),
		]);
		const o = memoryOrrery({
			exec: (command) =>
				command === "noisy"
					? {
							stdout: `${"x".repeat(100_000)}END`,
							stderr: "oops",
							exit_code: 2,
						}
					: command === "killed"
						? { cause: "oom_killed" }
						: {},
		});
		const { m, deps } = setup(o);
		await runAgent(m.run, deps);

		const [noisy, killed] = toolResults(m).map(resultText);
		expect(noisy).toContain("Exit code: 2");
		expect(noisy).toContain("oops");
		expect(noisy).toContain("END");
		expect(noisy.length).toBeLessThan(60_000);
		expect(noisy).toContain("cut off");
		expect(killed).toContain("oom_killed");
	});

	it("attaches only an existing regular file under /workspace to the reply", async () => {
		script([
			fauxAssistantMessage(
				fauxToolCall("attach", { path: "/workspace/out/./report.pdf" }),
			),
			fauxAssistantMessage(fauxToolCall("attach", { path: "out" })),
			fauxAssistantMessage(fauxToolCall("attach", { path: "/etc/passwd" })),
			fauxAssistantMessage(fauxToolCall("attach", { path: "../etc/passwd" })),
			fauxAssistantMessage("done"),
		]);
		// bash as it answers in a Sandbox holding out/report.pdf (12 bytes) and the folder out
		const o = memoryOrrery({
			exec: (command, files) => {
				files.set("out/report.pdf", new TextEncoder().encode("twelve bytes"));
				return command.includes("realpath")
					? command.includes("'/workspace/out/report.pdf'")
						? { stdout: "12\n/workspace/out/report.pdf" }
						: { exit_code: 1 }
					: {};
			},
		});
		const { m, deps } = setup(o);
		await runAgent(m.run, deps);

		const [file, folder, outside, escaping] = toolResults(m);
		expect(file.isError).toBe(false);
		expect(file.details).toEqual({
			attachment: {
				path: "/workspace/out/report.pdf",
				name: "report.pdf",
				size: 12,
			},
		});
		expect(resultText(file)).toContain("report.pdf");
		expect(new TextDecoder().decode(m.attached.get("report.pdf"))).toBe(
			"twelve bytes",
		);
		for (const refused of [folder, outside, escaping]) {
			expect(refused.isError).toBe(true);
			expect(resultText(refused)).toContain("/workspace");
		}
		// paths outside /workspace never reach the Sandbox
		expect(
			o.calls.filter(
				(c) => c.startsWith("createExec") && c.includes("realpath"),
			),
		).toHaveLength(2);
	});

	it("answers a clear error when orrery cannot be reached, and the Run goes on", async () => {
		script([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" })),
			fauxAssistantMessage("sorry"),
		]);
		const o = memoryOrrery();
		o.down = true;
		const { m, deps } = setup(o);
		await runAgent(m.run, deps);

		const [result] = toolResults(m);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("Sandbox");
		expect(resultText(result)).toContain("ECONNREFUSED");
		expect(m.over).toBe(true);
	});

	it("cancels the command running when the Run is stopped", async () => {
		script([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1000" })),
		]);
		const o = memoryOrrery({
			exec: (command, fs) =>
				command === "sleep 1000" ? { running: true } : shell(command, fs),
		});
		const { m, deps } = setup(o);
		const ran = runAgent(m.run, deps);
		while (!o.calls.includes("createExec sb1 sleep 1000"))
			await new Promise((resolve) => setTimeout(resolve, 1));
		m.stop();
		// however the handler ends, serveRuns ends a stopped Run as stopped
		await ran.catch(() => {});

		expect(o.calls.filter((c) => c.startsWith("cancelExec"))).toHaveLength(1);
	});
});

describe("runAgent with memory", () => {
	const memoryConfig = {
		...config,
		agents: [
			agent({ id: "remembers", tools: [] }),
			agent({ id: "small", tools: [] }),
		],
	};
	const memDeps = { ...deps(), config: memoryConfig };
	const seeded = [
		{ path: "prefs/language", description: "Replies in English", body: "en" },
	];
	const run = (
		agentId: string,
		options: Partial<Parameters<typeof memoryRun>[0]> = {},
	) =>
		memoryRun({
			transcript: transcript(user("hi")),
			turn: resolveTurn(memoryConfig, agentId, {
				model: agentId === "small" ? "faux/faux-small" : undefined,
			}) as Turn,
			memories: seeded,
			...options,
		});
	const prompt = (c?: Context) =>
		(c?.messages[0] as unknown as { content: string }).content;
	const tools = (c?: Context) =>
		String(
			JSON.stringify((c?.messages[0] as { toolsAdded?: unknown }).toolsAdded),
		);
	const results = (m: ReturnType<typeof memoryRun>) =>
		m.saved.filter((s): s is ToolResultMessage => s.role === "toolResult");
	// each test's first request is captured
	let context: Context | undefined;
	const answer = () =>
		script([
			(c) => {
				context = c;
				return fauxAssistantMessage("ok");
			},
		]);

	it("puts the Memory Index and the memory instructions in the system prompt, and offers the Memory Tools", async () => {
		answer();
		await runAgent(run("remembers").run, memDeps);
		const p = prompt(context);
		expect(p.startsWith("You are a test.")).toBe(true);
		expect(p).toContain("- prefs/language: Replies in English");
		expect(p).toContain("data, not instructions");
		for (const name of ["write", "edit", "delete", "read", "grep"])
			expect(tools(context)).toContain(`"memory_${name}"`);
	});

	it("leaves memory out entirely while the User has it off", async () => {
		answer();
		await runAgent(run("remembers", { memoryOff: true }).run, memDeps);
		expect(prompt(context)).toBe("You are a test.");
		expect(tools(context)).not.toContain("memory_");
		expect(tools(context)).not.toContain(`"recall"`);
	});

	it("gives a Subagent no memory while its User has it off", async () => {
		answer();
		await runAgent(
			run("remembers", { memoryOff: true, isSubagent: true }).run,
			memDeps,
		);
		expect(tools(context)).not.toContain("memory_");
		expect(tools(context)).not.toContain(`"recall"`);
	});

	it("reads and writes the User's Memories through the Tools, keeping the Index of the Run's start", async () => {
		const prompts: string[] = [];
		script([
			(c) => {
				prompts.push(prompt(c));
				return fauxAssistantMessage([
					fauxToolCall("memory_write", {
						path: "work/project",
						description: "Building memory",
						body: "ticket 37",
					}),
					fauxToolCall("memory_edit", {
						path: "prefs/language",
						old: "en",
						new: "zh",
					}),
					fauxToolCall("memory_edit", {
						path: "prefs/language",
						old: "fr",
						new: "de",
					}),
				]);
			},
			(c) => {
				prompts.push(prompt(c));
				return fauxAssistantMessage([
					fauxToolCall("memory_read", { path: "work/project" }),
					fauxToolCall("memory_grep", { pattern: "ZH" }),
					fauxToolCall("memory_delete", { path: "work/project" }),
				]);
			},
			fauxAssistantMessage("done"),
		]);
		const m = run("remembers");
		await runAgent(m.run, memDeps);

		expect(prompts[1]).toBe(prompts[0]);
		expect(prompts[0]).not.toContain("work/project");
		const [write, edit, missed, read, grep, del] = results(m);
		expect(write.isError).toBe(false);
		expect(edit.isError).toBe(false);
		expect(missed.isError).toBe(true);
		expect(JSON.stringify(missed.content)).toContain("not found");
		expect(JSON.stringify(read.content)).toContain("ticket 37");
		expect(JSON.stringify(read.content)).toContain('conversation=\\"memory\\"');
		expect(JSON.stringify(grep.content)).toContain("prefs/language");
		expect(del.isError).toBe(false);
		expect([...m.memories.values()]).toMatchObject([
			{ path: "prefs/language", body: "zh" },
		]);
	});

	it("cuts a long Memory Index, saying how many Memories it left out", async () => {
		answer();
		const many = Array.from({ length: 500 }, (_, i) => ({
			path: `notes/${i}`,
			description: "x".repeat(100),
			body: "b",
		}));
		await runAgent(run("remembers", { memories: many }).run, memDeps);
		const p = prompt(context);
		const listed = p.match(/^- notes\//gm)?.length ?? 0;
		expect(listed).toBeGreaterThan(10);
		expect(listed).toBeLessThan(500);
		expect(p).toContain(`${500 - listed} more memories are not listed`);
	});

	it("cuts a Memory Index in Chinese at about 2k tokens too, a token about a character", async () => {
		answer();
		const many = Array.from({ length: 500 }, (_, i) => ({
			path: `notes/${i}`,
			description: "长".repeat(100),
			body: "b",
		}));
		await runAgent(run("remembers", { memories: many }).run, memDeps);
		const listed = prompt(context).match(/^- notes\//gm)?.length ?? 0;
		expect(listed).toBeGreaterThan(10);
		expect(listed).toBeLessThanOrEqual(20);
	});

	it("keeps the Memory Index after compacting", async () => {
		const old = fauxAssistantMessage("b".repeat(2000));
		old.usage.totalTokens = 1500;
		script([
			fauxAssistantMessage("SUMMARY"),
			(c) => {
				context = c;
				return fauxAssistantMessage("ok");
			},
		]);
		const m = run("small", {
			transcript: transcript(user("a".repeat(4000)), old, user("next?")),
		});
		await runAgent(m.run, memDeps);
		expect(m.compactions).toHaveLength(1);
		expect(prompt(context)).toContain("- prefs/language: Replies in English");
	});

	it("lets a Subagent read the Memories and Recall, but not write, and tells it to report what is worth remembering", async () => {
		script([
			(c) => {
				context = c;
				return fauxAssistantMessage([
					fauxToolCall("memory_read", { path: "prefs/language" }),
				]);
			},
			fauxAssistantMessage("done"),
		]);
		const m = run("remembers", { isSubagent: true });
		await runAgent(m.run, memDeps);
		const p = prompt(context);
		expect(p).toContain("- prefs/language: Replies in English");
		expect(p).toContain("worth remembering");
		expect(p).not.toContain("memory_write");
		for (const name of ["read", "grep"])
			expect(tools(context)).toContain(`"memory_${name}"`);
		for (const name of ["write", "edit", "delete"])
			expect(tools(context)).not.toContain(`"memory_${name}"`);
		expect(tools(context)).toContain('"recall"');
		expect(JSON.stringify(results(m)[0].content)).toContain("en");
	});

	it("lets the general worker read the Memories too, as any Subagent", async () => {
		answer();
		await runAgent(
			memoryRun({
				transcript: transcript(user("hi")),
				turn: resolveTurn(memoryConfig, null) as Turn,
				memories: seeded,
				isSubagent: true,
			}).run,
			memDeps,
		);
		expect(tools(context)).toContain('"memory_read"');
		expect(tools(context)).not.toContain('"memory_write"');
		expect(tools(context)).toContain('"recall"');
	});

	for (const isSubagent of [false, true])
		it(`gives an Incognito Conversation's ${isSubagent ? "Subagent" : "Agent"} no memory`, async () => {
			answer();
			await runAgent(
				run("remembers", { incognito: true, isSubagent }).run,
				memDeps,
			);
			expect(prompt(context)).toBe("You are a test.");
			expect(tools(context)).not.toContain("memory_");
			expect(tools(context)).not.toContain('"recall"');
		});

	it("searches the User's past Conversations by keyword and time with Recall, lists them by time, and opens one", async () => {
		const searched: unknown[] = [];
		const at = new Date("2026-03-01T10:00:00Z");
		const recall = {
			search: async (keyword: string, range?: object) => {
				searched.push({ keyword, range });
				return [
					{ conversationId: "c1", title: "杭州", at, snippet: "去杭州出差" },
				];
			},
			list: async (range: object) => {
				searched.push({ range });
				return [{ conversationId: "c1", title: "杭州", at }];
			},
			open: async (id: string) =>
				id === "c1"
					? {
							title: "杭州",
							messages: [
								{ role: "user" as const, text: "去杭州出差", at },
								{ role: "assistant" as const, text: "好的", at },
							],
						}
					: undefined,
		};
		script([
			fauxAssistantMessage([
				fauxToolCall("recall", {
					query: "杭州",
					after: "2026-01-01",
					before: "2026-12-31T23:59:59Z",
				}),
				fauxToolCall("recall", { conversation: "c1" }),
				fauxToolCall("recall", { conversation: "c2" }),
				fauxToolCall("recall", {}),
				fauxToolCall("recall", { after: "2026-02-01" }),
			]),
			fauxAssistantMessage("done"),
		]);
		const m = run("remembers", { recall });
		await runAgent(m.run, memDeps);

		expect(searched).toEqual([
			{
				keyword: "杭州",
				range: {
					after: new Date("2026-01-01T00:00:00Z"),
					before: new Date("2026-12-31T23:59:59Z"),
				},
			},
			{ range: { after: new Date("2026-02-01T00:00:00Z"), before: undefined } },
		]);
		const [search, open, missing, neither, listed] = results(m);
		expect(JSON.stringify(search.content)).toContain("c1");
		expect(JSON.stringify(search.content)).toContain("去杭州出差");
		expect(JSON.stringify(search.content)).toContain("2026-03-01T10:00:00");
		expect(JSON.stringify(open.content)).toContain("好的");
		expect(missing.isError).toBe(true);
		expect(neither.isError).toBe(true);
		expect(JSON.stringify(listed.content)).toContain(
			'id=\\"c1\\" title=\\"杭州\\" last_message=\\"2026-03-01T10:00:00.000Z\\"',
		);
	});
});

describe("runAgent with a Document Parser", () => {
	// mineru.net answering every call at once, its result zip holding full.md
	const mineru = (async (url: string | URL) => {
		const at = String(url);
		if (at.endsWith("/file-urls/batch"))
			return Response.json({
				code: 0,
				data: { batch_id: "b", file_urls: ["https://oss.example/u"] },
			});
		if (at.includes("/extract-results/batch/"))
			return Response.json({
				code: 0,
				data: {
					extract_result: [
						{ state: "done", full_zip_url: "https://cdn.example/r.zip" },
					],
				},
			});
		if (at === "https://cdn.example/r.zip")
			return new Response(zip([{ path: "full.md", content: "# Report" }]));
		return new Response(null);
	}) as unknown as typeof fetch;
	const parseConfig = (sandbox: boolean) => ({
		...config,
		agents: [agent({ id: "reader", tools: ["parse"] })],
		tools: { parse: { baseUrl: "https://mineru.net", apiKey: "k" } },
		sandboxProvider: sandbox
			? { url: "http://o", token: "t", cpu: 2, memory: 2 ** 31 }
			: undefined,
	});

	it("parses an Attachment and writes its Markdown next to it in the Sandbox", async () => {
		const { store, objects } = memoryStore();
		objects.set("r/c/1", new TextEncoder().encode("%PDF"));
		script([
			fauxAssistantMessage(fauxToolCall("parse", { name: "report.pdf" })),
			fauxAssistantMessage("Read it"),
		]);
		const cfg = parseConfig(true);
		const o = memoryOrrery();
		const m = memoryRun({
			transcript: transcript(user("read report.pdf")),
			turn: resolveTurn(cfg, "reader") as Turn,
			attachments: { "report.pdf": "r/c/1" },
			orrery: o.client,
			store,
		});
		await runAgent(m.run, {
			config: cfg,
			openToolbox: ((services, allowed, options) =>
				openToolbox(services, allowed, {
					...options,
					fetch: mineru,
				})) as typeof openToolbox,
		});
		expect(JSON.stringify(m.saved[1])).toContain("# Report");
		expect(
			new TextDecoder().decode(
				o.files(m.sandboxId as string).get("uploads/report.pdf.md"),
			),
		).toBe("# Report");
	});
});

describe("runAgent traces", () => {
	const traced = (captureContent = false) => {
		const exporter = new InMemorySpanExporter();
		const provider = new TracerProvider({
			spanProcessors: [new SimpleSpanProcessor({ exporter })],
		});
		return {
			telemetry: otelTelemetry(provider.getTracer("test"), captureContent),
			spans: () => exporter.getFinishedSpans(),
		};
	};
	const named = (spans: ReadableSpan[], name: string) =>
		spans.filter((s) => s.name === name);

	it("traces the Run with a request span per step and one for the title, carrying whose it is and no cost or names", async () => {
		script(
			[
				fauxAssistantMessage(fauxToolCall("search", { query: "pi" }), {
					stopReason: "toolUse",
					responseId: "resp-1",
				}),
				fauxAssistantMessage("Pi is an agent", { responseId: "resp-2" }),
			],
			"About pi",
		);
		const t = traced();
		const m = memoryRun({
			transcript: transcript(user("what is pi?")),
			turn: turn(),
		});
		await runAgent(m.run, { ...deps(), telemetry: t.telemetry });

		const spans = t.spans();
		const [root] = named(spans, "invoke_agent");
		expect(root?.parentSpanContext).toBeUndefined();
		expect(root?.attributes).toMatchObject({
			"orqestra.run.outcome": "completed",
			"orqestra.run.steps": 2,
			"orqestra.run.unattended": false,
			"orqestra.run.subagent": false,
			"orqestra.purpose": "turn",
		});
		const chats = named(spans, "chat faux-1");
		expect(chats).toHaveLength(3);
		for (const chat of chats)
			expect(chat.parentSpanContext?.spanId).toBe(
				root?.spanContext().spanId as string,
			);
		expect(chats.map((c) => c.attributes["orqestra.purpose"])).toEqual([
			"step",
			"step",
			"title",
		]);
		expect(chats[0]?.attributes).toMatchObject({
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": "faux",
			"gen_ai.request.model": "faux-1",
			"gen_ai.response.finish_reasons": ["toolUse"],
			"gen_ai.response.id": "resp-1",
			"gen_ai.usage.input_tokens": expect.any(Number),
			"gen_ai.usage.output_tokens": expect.any(Number),
			"gen_ai.usage.cache_read.input_tokens": expect.any(Number),
			"gen_ai.usage.cache_creation.input_tokens": expect.any(Number),
		});
		for (const span of spans) {
			expect(span.attributes).toMatchObject({
				"user.id": "memory-user",
				"gen_ai.agent.id": "faux",
				"gen_ai.conversation.id": "memory",
				"orqestra.conversation.root_id": "memory",
			});
			const all = JSON.stringify([span.attributes, span.events]);
			expect(all).not.toMatch(/cost|Faux|About pi|what is pi/);
			expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
		}
	});

	// the trace context of a Tool call span another Run made
	const toolCall = async (t: ReturnType<typeof traced>) => {
		let carrier: Record<string, string> | undefined;
		await t.telemetry.startSpan({ name: "execute_tool subagent" }, (span) => {
			carrier = span.propagation?.inject(span);
		});
		const [span] = named(t.spans(), "execute_tool subagent");
		return { carrier: carrier as Record<string, string>, span };
	};

	it("starts a Subagent's first Run under the Tool call that started it", async () => {
		script([fauxAssistantMessage("found")]);
		const t = traced();
		const started = await toolCall(t);
		const m = memoryRun({
			transcript: transcript(user("brief")),
			turn: turn(),
			isSubagent: true,
			trace: { parent: started.carrier, links: [] },
		});
		await runAgent(m.run, { ...deps(), telemetry: t.telemetry });

		const [root] = named(t.spans(), "invoke_agent");
		expect(root?.spanContext().traceId).toBe(
			started.span?.spanContext().traceId as string,
		);
		expect(root?.parentSpanContext?.spanId).toBe(
			started.span?.spanContext().spanId as string,
		);
		expect(root?.links).toEqual([]);
	});

	it("makes a woken Run a root of its own, linked to the Tool call that set the work going", async () => {
		script([fauxAssistantMessage("summed up")]);
		const t = traced();
		const started = await toolCall(t);
		const m = memoryRun({
			transcript: transcript(user("[Subagent 1 completed]")),
			turn: turn(),
			titled: true,
			trace: { links: [started.carrier] },
		});
		await runAgent(m.run, { ...deps(), telemetry: t.telemetry });

		const [root] = named(t.spans(), "invoke_agent");
		expect(root?.parentSpanContext).toBeUndefined();
		expect(root?.spanContext().traceId).not.toBe(
			started.span?.spanContext().traceId as string,
		);
		expect(root?.links.map((l) => l.context.spanId)).toEqual([
			started.span?.spanContext().spanId as string,
		]);
	});

	it("hands the trace context of the Tool call that starts or continues a Subagent to it", async () => {
		script([
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", { tasks: [{ brief: "dig" }] }, { id: "s" }),
					fauxToolCall(
						"subagent_message",
						{ number: 1, message: "more" },
						{ id: "m" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("waiting"),
		]);
		const t = traced();
		const handed: Record<string, Record<string, string> | undefined> = {};
		const m = memoryRun({
			transcript: transcript(user("delegate")),
			turn: turn(),
			titled: true,
			subagents: {
				start: async (_id, _tasks, trace) => {
					handed.start = trace;
					return [1];
				},
				message: async (_n, _text, trace) => {
					handed.message = trace;
					return { continued: true };
				},
				stop: async () => [],
			},
		});
		await runAgent(m.run, { ...deps(), telemetry: t.telemetry });

		const id = (name: string) =>
			named(t.spans(), `execute_tool ${name}`)[0]?.spanContext().spanId;
		expect(handed.start?.traceparent).toContain(id("subagent") as string);
		expect(handed.message?.traceparent).toContain(
			id("subagent_message") as string,
		);
	});

	it("traces each Tool call under the Run, with its name and call id but no arguments or result", async () => {
		script([
			fauxAssistantMessage(
				fauxToolCall("search", { query: "secret words" }, { id: "call-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const t = traced();
		const m = memoryRun({
			transcript: transcript(user("look it up")),
			turn: turn(),
			titled: true,
		});
		await runAgent(m.run, {
			...deps([{ title: "Result page", content: "hidden result" }]),
			telemetry: t.telemetry,
		});

		const [root] = named(t.spans(), "invoke_agent");
		const tools = named(t.spans(), "execute_tool search");
		expect(tools).toHaveLength(1);
		expect(tools[0]?.parentSpanContext?.spanId).toBe(
			root?.spanContext().spanId as string,
		);
		expect(tools[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
		expect(tools[0]?.attributes).toMatchObject({
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "search",
			"gen_ai.tool.call.id": "call-1",
			"user.id": "memory-user",
			"gen_ai.agent.id": "faux",
			"gen_ai.conversation.id": "memory",
			"orqestra.conversation.root_id": "memory",
			"orqestra.purpose": "turn",
		});
		expect(tools[0]?.attributes["orqestra.mcp_server.id"]).toBeUndefined();
		expect(
			JSON.stringify([tools[0]?.attributes, tools[0]?.events]),
		).not.toMatch(/secret words|hidden result|Result page/);
	});

	it("marks a failed Tool call with a category: tool_error for an MCP Tool's isError, _OTHER for a throw", async () => {
		const fake = fakeMcpServer({
			tools: [
				{
					name: "fail",
					inputSchema: { type: "object" as const },
					call: () => ({
						content: [{ type: "text" as const, text: "it broke: secret" }],
						isError: true,
					}),
				},
			],
		});
		const mcpConfig = {
			...config,
			agents: [agent({ id: "mcp", tools: ["search", "mcp:s"] })],
			mcpServers: {
				s: { name: "S", url: "https://s.example.com/mcp", headers: {} },
			},
		};
		script([
			fauxAssistantMessage(
				[
					fauxToolCall("s__fail", {}, { id: "call-mcp" }),
					fauxToolCall("search", { query: "x" }, { id: "call-search" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const t = traced();
		const m = memoryRun({
			transcript: transcript(user("try")),
			turn: resolveTurn(mcpConfig, "mcp") as Turn,
			titled: true,
		});
		await runAgent(m.run, {
			config: mcpConfig,
			// Search's provider is down; the MCP Server answers
			openToolbox: ((services, allowed, options) =>
				openToolbox(services, allowed, {
					...options,
					fetch: (async (input: string | URL, init?: RequestInit) =>
						String(input).includes("tavily")
							? new Response("down", { status: 500 })
							: fake.fetch(input, init)) as typeof fetch,
				})) as typeof openToolbox,
			telemetry: t.telemetry,
		});

		const [mcp] = named(t.spans(), "execute_tool s__fail");
		expect(mcp?.status.code).toBe(SpanStatusCode.ERROR);
		expect(mcp?.attributes).toMatchObject({
			"error.type": "tool_error",
			"orqestra.mcp_server.id": "s",
			"gen_ai.tool.call.id": "call-mcp",
		});
		const [search] = named(t.spans(), "execute_tool search");
		expect(search?.status.code).toBe(SpanStatusCode.ERROR);
		expect(search?.attributes["error.type"]).toBe("_OTHER");
		expect(
			JSON.stringify(t.spans().map((s) => [s.status, s.attributes, s.events])),
		).not.toMatch(/secret|down/);
	});

	it("marks a Tool call that timed out or never reached its service as such", async () => {
		const failures = [
			[new DOMException("The operation timed out.", "TimeoutError"), "timeout"],
			[new TypeError("fetch failed"), "unavailable"],
		] as const;
		for (const [thrown, type] of failures) {
			script([
				fauxAssistantMessage(fauxToolCall("search", { query: "x" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const t = traced();
			const m = memoryRun({
				transcript: transcript(user("try")),
				turn: turn(),
				titled: true,
			});
			await runAgent(m.run, {
				...deps(),
				openToolbox: ((services, allowed, options) =>
					openToolbox(services, allowed, {
						...options,
						fetch: (async () => {
							throw thrown;
						}) as unknown as typeof fetch,
					})) as typeof openToolbox,
				telemetry: t.telemetry,
			});
			const [search] = named(t.spans(), "execute_tool search");
			expect(search?.attributes["error.type"]).toBe(type);
		}
	});

	it("traces compaction as a request of its own", async () => {
		const old = fauxAssistantMessage("b".repeat(2000));
		old.usage.totalTokens = 1500;
		script([fauxAssistantMessage("SUMMARY"), fauxAssistantMessage("ok")]);
		const t = traced();
		const m = memoryRun({
			transcript: transcript(user("a".repeat(4000)), old, user("next?")),
			turn: turn("small", "faux/faux-small"),
			titled: true,
		});
		await runAgent(m.run, { ...deps(), telemetry: t.telemetry });

		expect(
			named(t.spans(), "chat faux-small").map(
				(c) => c.attributes["orqestra.purpose"],
			),
		).toEqual(["compaction", "step"]);
	});

	it("marks a failed request and its Run with a category only, never the Provider's text", async () => {
		faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "429 rate limit: you said what is pi?",
			}),
		]);
		const t = traced();
		const m = memoryRun({
			transcript: transcript(user("what is pi?")),
			turn: turn(),
		});
		await expect(
			runAgent(m.run, { ...deps(), telemetry: t.telemetry }),
		).rejects.toThrow();

		const [chat] = named(t.spans(), "chat faux-1");
		expect(chat?.status.code).toBe(SpanStatusCode.ERROR);
		expect(chat?.attributes).toMatchObject({
			"error.type": "rate_limited",
			"http.response.status_code": 429,
		});
		const [root] = named(t.spans(), "invoke_agent");
		expect(root?.status.code).toBe(SpanStatusCode.ERROR);
		expect(root?.attributes).toMatchObject({
			"error.type": "model_request_failed",
			"orqestra.run.outcome": "failed",
		});
		expect(
			JSON.stringify(t.spans().map((s) => [s.status, s.attributes, s.events])),
		).not.toContain("what is pi");
	});

	it("carries the messages, Memory, Tool arguments and results only when content capture is on", async () => {
		const remembers = {
			...config,
			agents: [agent({ id: "remembers", tools: ["search"] })],
		};
		const said =
			/hello there|Food taste|likes durian|secret words|hidden result|secret reply|You are a test/;
		for (const [value, on] of [
			[undefined, false],
			["NO_CONTENT", false],
			["EVENT_ONLY", false],
			["bogus", false],
			["true", true],
			["SPAN_ONLY", true],
			["SPAN_AND_EVENT", true],
		] as const) {
			script([
				fauxAssistantMessage(
					[
						fauxToolCall("memory_read", { path: "food/taste" }),
						fauxToolCall("search", { query: "secret words" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("secret reply"),
			]);
			const { captureContent } = tracing({
				OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT: value,
			});
			const t = traced(captureContent);
			const m = memoryRun({
				transcript: transcript(user("hello there")),
				turn: resolveTurn(remembers, "remembers") as Turn,
				memories: [
					{
						path: "food/taste",
						description: "Food taste",
						body: "likes durian",
					},
				],
				titled: true,
			});
			await runAgent(m.run, {
				...deps([{ title: "Result page", content: "hidden result" }]),
				config: remembers,
				telemetry: t.telemetry,
				captureContent,
			});

			const all = JSON.stringify(
				t.spans().map((s) => [s.status, s.attributes, s.events]),
			);
			if (!on) {
				expect(all).not.toMatch(said);
				continue;
			}
			for (const text of String(said.source).split("|"))
				expect(all).toContain(text);
			const [first, last] = named(t.spans(), "chat faux-1");
			expect(first?.attributes["gen_ai.system_instructions"]).toContain(
				"You are a test",
			);
			expect(first?.attributes["gen_ai.input.messages"]).toContain(
				"hello there",
			);
			expect(first?.attributes["gen_ai.output.messages"]).toContain(
				"secret words",
			);
			expect(last?.attributes["gen_ai.output.messages"]).toContain(
				"secret reply",
			);
			const [search] = named(t.spans(), "execute_tool search");
			expect(search?.attributes["gen_ai.tool.call.arguments"]).toContain(
				"secret words",
			);
			expect(search?.attributes["gen_ai.tool.call.result"]).toContain(
				"hidden result",
			);
			const [read] = named(t.spans(), "execute_tool memory_read");
			expect(read?.attributes["gen_ai.tool.call.result"]).toContain(
				"likes durian",
			);
		}
	});

	it("keeps the error text with content capture on", async () => {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("search", { query: "x" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "429 rate limit: you said what is pi?",
			}),
		]);
		const t = traced(true);
		const m = memoryRun({
			transcript: transcript(user("what is pi?")),
			turn: turn(),
			titled: true,
		});
		await expect(
			runAgent(m.run, {
				...deps(),
				openToolbox: ((services, allowed, options) =>
					openToolbox(services, allowed, {
						...options,
						fetch: (async () =>
							new Response("search is down", {
								status: 500,
							})) as unknown as typeof fetch,
					})) as typeof openToolbox,
				telemetry: t.telemetry,
				captureContent: true,
			}),
		).rejects.toThrow();

		const [, chat] = named(t.spans(), "chat faux-1");
		expect(chat?.attributes["error.type"]).toBe("rate_limited");
		expect(chat?.status.message).toBe("429 rate limit: you said what is pi?");
		const [search] = named(t.spans(), "execute_tool search");
		expect(search?.attributes["error.type"]).toBe("_OTHER");
		expect(search?.status.message).toContain("search is down");
	});

	it("marks no error on a stopped Run, nor on a partial Unattended one, whose Firing's ids it carries", async () => {
		script([fauxAssistantMessage("word ".repeat(2000))]);
		const t = traced();
		const stopped = memoryRun({
			transcript: transcript(user("write a lot")),
			turn: turn(),
			titled: true,
		});
		const stream = stopped.run.stream;
		stopped.run.stream = async (event) => {
			if (event.type === "delta") stopped.stop();
			await stream(event);
		};
		await runAgent(stopped.run, { ...deps(), telemetry: t.telemetry });

		script([fauxAssistantMessage("enough")]);
		const partial = memoryRun({
			transcript: transcript(user("check")),
			turn: turn(),
			unattended: true,
			titled: true,
			scheduledTaskId: "task-1",
			firingId: 7,
		});
		await runAgent(partial.run, {
			...deps(),
			config: {
				...config,
				limits: { ...DEFAULT_LIMITS, unattendedMaxSteps: 1 },
			},
			telemetry: t.telemetry,
		});

		const runs = named(t.spans(), "invoke_agent");
		expect(runs.map((r) => r.attributes["orqestra.run.outcome"])).toEqual([
			"stopped",
			"partial",
		]);
		for (const span of t.spans())
			expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
		expect(runs[1]?.attributes).toMatchObject({
			"orqestra.run.unattended": true,
			"orqestra.purpose": "firing",
			"orqestra.scheduled_task.id": "task-1",
			"orqestra.firing.id": 7,
		});
		expect(named(t.spans(), "chat faux-1")[1]?.attributes).toMatchObject({
			"orqestra.scheduled_task.id": "task-1",
			"orqestra.firing.id": 7,
		});
	});

	it("marks no error on a Run stopped, or timed out, during a Tool call, nor on that call", async () => {
		for (const end of ["stop", "timeOut"] as const) {
			script([
				fauxAssistantMessage(fauxToolCall("search", { query: "slow" }), {
					stopReason: "toolUse",
				}),
			]);
			const t = traced();
			const m = memoryRun({
				transcript: transcript(user("look it up")),
				turn: turn(),
				titled: true,
				unattended: end === "timeOut",
			});
			let searching = false;
			// Search hangs until the call is cancelled
			const ran = runAgent(m.run, {
				...deps(),
				openToolbox: ((services, allowed, options) =>
					openToolbox(services, allowed, {
						...options,
						fetch: ((_input: string | URL, init?: RequestInit) => {
							searching = true;
							return new Promise((_, reject) =>
								init?.signal?.addEventListener("abort", () =>
									reject(init.signal?.reason),
								),
							);
						}) as typeof fetch,
					})) as typeof openToolbox,
				telemetry: t.telemetry,
			});
			while (!searching) await new Promise((r) => setTimeout(r, 1));
			m[end]();
			await ran.catch(() => {});

			const [tool] = named(t.spans(), "execute_tool search");
			const [run] = named(t.spans(), "invoke_agent");
			expect(tool?.status.code).not.toBe(SpanStatusCode.ERROR);
			expect(run?.status.code).not.toBe(SpanStatusCode.ERROR);
			expect(run?.attributes["orqestra.run.outcome"]).toBe(
				end === "stop" ? "stopped" : "partial",
			);
		}
	});

	it("marks no error on a Run stopped, or timed out, before its reply began", async () => {
		for (const end of ["stop", "timeOut"] as const) {
			const t = traced();
			const m = memoryRun({
				transcript: transcript(user("hi")),
				turn: turn(),
				titled: true,
			});
			m[end]();
			await runAgent(m.run, { ...deps(), telemetry: t.telemetry }).catch(
				() => {},
			);

			const [run] = named(t.spans(), "invoke_agent");
			expect(run?.status.code).not.toBe(SpanStatusCode.ERROR);
			expect(run?.attributes["orqestra.run.outcome"]).toBe(
				end === "stop" ? "stopped" : "partial",
			);
		}
	});
});
