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
import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import {
	type AgentDefinition,
	type OrqestraConfig,
	resolveTurn,
} from "@orqestra/config";
import type { Transcript, Turn } from "@orqestra/conversations";
import { memoryRun } from "@orqestra/conversations/testing";
import { openToolbox } from "@orqestra/tools";
import { memoryOrrery } from "@orqestra/tools/testing";
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
	skills: [],
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
	skills: {},
};
const turn = (agentId = "faux") => resolveTurn(config, agentId) as Turn;

const noSkillFiles = async () => [];

// Search answers with `results`
const deps = (results: unknown[] = []) => ({
	config,
	streamSimple,
	skillFiles: noSkillFiles,
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

	it("does not fail the Run when two MCP Tools end up with the same name", async () => {
		// an MCP Server whose Tools "a.b" and "a_b" both become "s__a_b"; each echoes which one ran
		const { client, server } = createInMemoryTransportPair();
		server.onMessage(async (message) => {
			const m = message as {
				id?: number;
				method?: string;
				params?: { name?: string; protocolVersion?: string };
			};
			const result =
				m.method === "initialize"
					? {
							protocolVersion: m.params?.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "s", version: "1" },
						}
					: m.method === "tools/list"
						? {
								tools: ["a.b", "a_b"].map((name) => ({
									name,
									inputSchema: { type: "object" },
								})),
							}
						: m.method === "tools/call"
							? { content: [{ type: "text", text: `ran ${m.params?.name}` }] }
							: undefined;
			if (m.id !== undefined && result)
				await server.send({
					jsonrpc: "2.0",
					id: m.id,
					result,
				} as JsonRpcMessage);
		});
		void server.start();
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
			streamSimple,
			skillFiles: noSkillFiles,
			openToolbox: ((services, allowed, options) =>
				openToolbox(services, allowed, {
					...options,
					mcpTransport: () => client,
				})) as typeof openToolbox,
		});

		expect(offered.filter((n) => n.startsWith("s__"))).toEqual(["s__a_b"]);
		expect(roles(m.saved)).toEqual(["assistant", "toolResult", "assistant"]);
		expect(JSON.stringify(m.saved[1])).toContain("ran a.b");
		expect(m.over).toBe(true);
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
		}),
		deps: {
			config: cfg,
			streamSimple,
			openToolbox,
			skillFiles,
			orrery: () => o.client,
		},
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
	// besides the Subagent Tools every top-level Agent has
	const offeredTools = (c?: Context) =>
		(
			c?.messages.flatMap(
				(msg) =>
					(msg as { toolsAdded?: { name: string }[] }).toolsAdded?.map(
						(t) => t.name,
					) ?? [],
			) ?? []
		).filter((n) => !n.startsWith("subagent"));

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

	it("offers no Sandbox, Tools or Skill list without a Sandbox Provider or an available Skill", async () => {
		for (const cfg of [
			{ ...skillConfig(), sandboxProvider: undefined },
			{
				...skillConfig(),
				agents: [agent({ id: "skilled", tools: [], skills: ["gone"] })],
			},
		]) {
			let context: Context | undefined;
			script([
				(c) => {
					context = c;
					return fauxAssistantMessage("ok");
				},
			]);
			const { m, deps } = setup(memoryOrrery(), cfg);
			await runAgent(m.run, deps);
			expect(systemPrompt(context)).toBe("You are a test.");
			expect(offeredTools(context)).toEqual([]);
		}
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
			exec: (command) =>
				command.includes("realpath")
					? command.includes("'/workspace/out/report.pdf'")
						? { stdout: "12\n/workspace/out/report.pdf" }
						: { exit_code: 1 }
					: {},
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
