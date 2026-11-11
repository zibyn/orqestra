import type { SerializedTaskReference } from "@modelcontextprotocol/ext-tasks/client";
import { describe, expect, it, vi } from "vitest";
import { openToolbox, type ToolServices } from "./index.ts";
import { connectMcpServer, pollMcpTask } from "./mcp.ts";
import {
	type FakeTool,
	fakeMcpServer,
	type McpEra,
	memoryConnections,
} from "./testing.ts";

type Fake = ReturnType<typeof fakeMcpServer>;
const fakeServer = (tools: FakeTool[], era?: McpEra) =>
	fakeMcpServer({ tools, era });
/** One fetch for several fake MCP Servers, each reached at https://{id}.example.com/mcp. */
const route =
	(fakes: Record<string, Fake>) => (input: string | URL, init?: RequestInit) =>
		fakes[new URL(input).hostname.split(".")[0]].fetch(input, init);

const server = (id: string) => ({
	name: id,
	url: `https://${id}.example.com/mcp`,
	headers: {},
});
const config = (...ids: string[]) =>
	({
		tools: {},
		mcpServers: Object.fromEntries(ids.map((id) => [id, server(id)])),
	}) as ToolServices;

const echo: FakeTool = {
	name: "echo",
	inputSchema: { type: "object" },
	call: ({ text }) => ({ content: [{ type: "text", text: String(text) }] }),
};
const never = new AbortController().signal;

describe("openToolbox with MCP Servers", () => {
	describe("a per-User OAuth MCP Server", () => {
		const connected = (
			store: ReturnType<typeof memoryConnections>,
			user: string,
		) =>
			store.saveConnection(user, "github", {
				tokens: { access_token: `token-of-${user}`, token_type: "Bearer" },
				issuer: "https://as.example.com",
			});
		const open = (
			fakes: Record<string, Fake>,
			connections: ReturnType<typeof memoryConnections>,
			userId?: string,
		) => {
			const services = config("wiki", "github");
			services.mcpServers.github.auth = "oauth";
			return openToolbox(services, ["mcp:wiki", "mcp:github"], {
				signal: never,
				fetch: route(fakes),
				userId,
				connections,
			});
		};

		it("offers its Tools when the Run's User is connected, sending their own token, and leaves shared ones as they were", async () => {
			const fakes = { wiki: fakeServer([echo]), github: fakeServer([echo]) };
			const connections = memoryConnections();
			await connected(connections, "ada");
			await connected(connections, "bob");
			const { tools, close } = await open(fakes, connections, "ada");
			expect(tools.map((t) => t.name).sort()).toEqual([
				"github__echo",
				"wiki__echo",
			]);
			await tools.find((t) => t.name === "github__echo")?.execute("1", {});
			expect(
				new Set(
					fakes.github.requests.map((r) => r.headers.get("authorization")),
				),
			).toEqual(new Set(["Bearer token-of-ada"]));
			expect(fakes.wiki.requests[0].headers.get("authorization")).toBeNull();
			await close();
		});

		it("leaves it out, without connecting or an error, when the User has no usable Connection", async () => {
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			const connections = memoryConnections();
			const stored = {
				tokens: { access_token: "t", token_type: "Bearer" },
				issuer: "https://as.example.com",
				scope: null,
				connectedAt: new Date(),
			};
			connections.connections.set("needs github", {
				...stored,
				status: "needs_reconnect",
			});
			// tokens sealed with another key
			connections.connections.set("other-key github", {
				...stored,
				tokens: undefined,
				status: "connected",
			});
			for (const userId of [undefined, "nobody", "needs", "other-key"]) {
				const fakes = { wiki: fakeServer([echo]), github: fakeServer([echo]) };
				const { tools, close } = await open(fakes, connections, userId);
				expect(tools.map((t) => t.name)).toEqual(["wiki__echo"]);
				expect(fakes.github.requests).toEqual([]);
				await close();
			}
			expect(errors).not.toHaveBeenCalled();
			errors.mockRestore();
		});
	});

	it("offers the Tools of allowed, available MCP Servers, prefixed with the server id and cleaned up", async () => {
		const fakes = {
			github: fakeServer([
				{
					name: "search.issues",
					title: "Search issues",
					description: "Find issues",
					inputSchema: {
						type: "object",
						properties: { q: { type: "string" } },
					},
				},
				{ name: `long${"x".repeat(80)}`, inputSchema: { type: "object" } },
			]),
			wiki: fakeServer([echo]),
			other: fakeServer([echo]),
		};
		const { tools, close } = await openToolbox(
			config("github", "wiki", "other"),
			["search", "mcp:github", "mcp:wiki", "mcp:gone"],
			{
				signal: never,
				fetch: route(fakes),
			},
		);
		expect(
			tools.map(({ name, label, description, parameters }) => ({
				name,
				label,
				description,
				parameters,
			})),
		).toEqual([
			{
				name: "github__search_issues",
				label: "Search issues",
				description: "Find issues",
				parameters: {
					type: "object",
					properties: { q: { type: "string" } },
				} as never,
			},
			{
				name: `github__long${"x".repeat(52)}`,
				label: `long${"x".repeat(80)}`,
				description: `long${"x".repeat(80)}`,
				parameters: { type: "object", properties: {} } as never,
			},
			{
				name: "wiki__echo",
				label: "echo",
				description: "echo",
				parameters: { type: "object", properties: {} } as never,
			},
		]);
		await close();
	});

	it("offers only the first of Tools whose names end up the same, so the Run still works", async () => {
		const fake = fakeServer([
			{ ...echo, name: "a.b" },
			{ ...echo, name: "a_b", call: () => ({ content: [] }) },
		]);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
		});
		expect(tools.map((t) => [t.name, t.label])).toEqual([["s__a_b", "a.b"]]);
		await close();
	});

	it("returns text and images, cutting long text with a notice", async () => {
		const fake = fakeServer([
			{
				name: "shot",
				inputSchema: { type: "object" },
				call: () => ({
					content: [
						{ type: "text", text: "a".repeat(60_000) },
						{ type: "image", data: "aGk=", mimeType: "image/png" },
					],
				}),
			},
		]);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
		});
		const result = await tools[0].execute("1", {}, never);
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([
			{
				type: "text",
				text: `${"a".repeat(50_000)}\n\n[The result was cut off here.]`,
			},
			{ type: "image", data: "aGk=", mimeType: "image/png" },
		]);
		await close();
	});

	it("reports an MCP Tool's own error as a Tool error", async () => {
		const fake = fakeServer([
			{
				name: "fail",
				inputSchema: { type: "object" },
				call: () => ({
					content: [{ type: "text", text: "no such repo" }],
					isError: true,
				}),
			},
		]);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
		});
		const result = await tools[0].execute("1", {}, never);
		expect(result).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "no such repo" }],
		});
		await close();
	});

	it("skips an MCP Server it cannot reach, and the others still work", async () => {
		const up = fakeServer([echo]);
		const down = fakeServer([echo]);
		down.down = true;
		const { tools, close } = await openToolbox(
			config("down", "up"),
			["mcp:down", "mcp:up"],
			{ signal: never, fetch: route({ down, up }), timeoutMs: 50 },
		);
		expect(tools.map((t) => t.name)).toEqual(["up__echo"]);
		const result = await tools[0].execute("1", { text: "hi" }, never);
		expect(result.content).toEqual([{ type: "text", text: "hi" }]);
		await close();
	});

	it.each<McpEra>([
		"legacy",
		"dual",
		"modern",
	])("calls the Tools of a %s server", async (era) => {
		const fake = fakeServer([echo], era);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
		});
		const result = await tools[0].execute("1", { text: "hi" }, never);
		expect(result).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "hi" }],
		});
		await close();
	});

	it("fails a call whose service asks for more input, saying Orqestra does not support that", async () => {
		const fake = fakeServer(
			[
				{
					name: "ask",
					inputSchema: { type: "object" },
					call: () => ({ inputRequired: true }),
				},
			],
			"modern",
		);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
		});
		await expect(tools[0].execute("1", {}, never)).rejects.toThrow(
			"This service asked for more input, which Orqestra does not support.",
		);
		await close();
	});

	it("stops connecting when the Run stops", async () => {
		const fake = fakeServer([echo]);
		fake.delayMs = 10_000; // listening, but never answers
		const stop = new AbortController();
		const connecting = openToolbox(config("s"), ["mcp:s"], {
			signal: stop.signal,
			fetch: fake.fetch,
		});
		setTimeout(() => stop.abort(new Error("stopped")), 10);
		const { tools, close } = await connecting;
		expect(tools).toEqual([]);
		await close();
	}, 1000);

	it("ends a call when the Run stops", async () => {
		const fake = fakeServer([
			{
				name: "hang",
				inputSchema: { type: "object" },
				call: () => new Promise(() => {}),
			},
		]);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
		});
		const stop = new AbortController();
		const call = tools[0].execute("1", {}, stop.signal);
		stop.abort(new Error("stopped"));
		await expect(call).rejects.toThrow();
		await close();
	});

	it("ends a call that takes too long", async () => {
		const fake = fakeServer([
			{
				name: "hang",
				inputSchema: { type: "object" },
				call: () => new Promise(() => {}),
			},
		]);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
			timeoutMs: 50,
		});
		await expect(tools[0].execute("1", {}, never)).rejects.toThrow(/time/i);
		await close();
	});

	it("closes every connection when done, ending calls still under way", async () => {
		const hang: FakeTool = {
			name: "hang",
			inputSchema: { type: "object" },
			call: () => new Promise(() => {}),
		};
		const { tools, close } = await openToolbox(
			config("a", "b"),
			["mcp:a", "mcp:b"],
			{
				signal: never,
				fetch: route({ a: fakeServer([hang]), b: fakeServer([hang]) }),
			},
		);
		const calls = tools.map((t) => t.execute("1", {}, never));
		await close();
		for (const call of calls) await expect(call).rejects.toThrow();
	});
});

describe("connectMcpServer and the Tasks extension", () => {
	it("hands a task off, then looks it up once per resume, with the server's headers", async () => {
		const fake = fakeMcpServer({
			era: "modern",
			tools: [
				{
					name: "slow",
					inputSchema: { type: "object" },
					call: () => ({ task: { status: "working", pollIntervalMs: 10 } }),
				},
			],
		});
		const connect = () =>
			connectMcpServer(
				"https://s.example.com/mcp",
				{ headers: { Authorization: "Bearer s3cret" } },
				{ signal: never, timeoutMs: 1000, fetch: fake.fetch },
			);
		const gets = () => fake.requests.filter((r) => r.method === "tasks/get");

		const run = await connect();
		const started = await run.session.callTool("slow", {});
		if (started.kind !== "task") throw new Error("expected a task");
		let reference: SerializedTaskReference | undefined;
		await started.handoff((r) => {
			reference = r;
		});
		await started.result(); // settles once handed off, so closing does not cancel it
		await run.close();
		const handedOff = reference;
		if (!handedOff) throw new Error("expected a reference");

		const poll = async () => {
			const job = await connect();
			const resumed = await job.session.resumeTask(handedOff);
			const first = await resumed.updates()[Symbol.asyncIterator]().next();
			const outcome =
				first.value?.type === "task" && first.value.task.status !== "working"
					? await resumed.result()
					: undefined;
			await resumed.detach();
			await resumed.result();
			await job.close();
			return { first: first.value, outcome };
		};
		expect((await poll()).first).toMatchObject({
			type: "task",
			task: { status: "working", suggestedPollIntervalMs: 10 },
		});
		await new Promise((r) => setTimeout(r, 50)); // several poll intervals
		expect(gets()).toHaveLength(1);

		Object.assign(fake.tasks.get("task-1") ?? {}, {
			status: "completed",
			result: { content: [{ type: "text", text: "done" }] },
		});
		expect((await poll()).outcome).toMatchObject({
			status: "completed",
			result: { content: [{ type: "text", text: "done" }] },
		});
		expect(gets()).toHaveLength(2);
		expect(fake.requests.map((r) => r.method)).not.toContain("tasks/cancel");
		for (const r of fake.requests)
			expect(r.headers.get("authorization")).toBe("Bearer s3cret");
	});
});

describe("openToolbox with Background Calls", () => {
	type Started = Parameters<
		NonNullable<Parameters<typeof openToolbox>[2]["backgroundCall"]>
	>[0];
	const started: Started[] = [];
	const backgroundCall = async (call: Started) => {
		started.push(call);
		return {
			content: [{ type: "text" as const, text: "in the background" }],
			details: { backgroundCall: "bc-1" },
		};
	};
	const declaresTasks = (r: Fake["requests"][number]) =>
		JSON.stringify(r.params?._meta ?? {}).includes(
			"io.modelcontextprotocol/tasks",
		);

	it.each([
		"legacy",
		"dual",
		"modern",
	] as const)("answers an immediate result as before on a %s server", async (era) => {
		const fake = fakeServer([echo], era);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
			backgroundCall,
		});
		const result = await tools[0].execute("1", { text: "hi" }, never);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "hi" }],
			isError: false,
		});
		await close();
	});

	it("declares the Tasks extension on every Tool call, and not without a way to start a Background Call", async () => {
		const fake = fakeServer([echo], "modern");
		for (const withCallback of [true, false]) {
			const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
				signal: never,
				fetch: fake.fetch,
				backgroundCall: withCallback ? backgroundCall : undefined,
			});
			await tools[0].execute("1", { text: "hi" }, never);
			await close();
		}
		const calls = fake.requests.filter((r) => r.method === "tools/call");
		expect(calls.map(declaresTasks)).toEqual([true, false]);
	});

	it("hands a call the server puts in the background to the Background Call, and leaves the task running when it closes", async () => {
		started.length = 0;
		const fake = fakeServer(
			[
				{
					name: "slow",
					inputSchema: { type: "object" },
					call: () => ({ task: { status: "working" } }),
				},
			],
			"modern",
		);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
			backgroundCall,
		});
		const result = await tools[0].execute("call-7", {}, never);
		await close();
		expect(result).toMatchObject({
			content: [{ type: "text", text: "in the background" }],
			details: { backgroundCall: "bc-1" },
		});
		expect(started).toEqual([
			{
				toolCallId: "call-7",
				serverId: "s",
				toolName: "slow",
				reference: expect.objectContaining({ taskId: "task-1" }),
			},
		]);
		const methods = fake.requests.map((r) => r.method);
		expect(methods).not.toContain("tasks/cancel");
		expect(methods).not.toContain("tasks/get");
	});

	it("polls a handed-off task once per look, and gets its result as an immediate one would be, even after its server moved", async () => {
		started.length = 0;
		const fake = fakeServer(
			[
				{
					name: "slow",
					inputSchema: { type: "object" },
					call: () => ({ task: { status: "working", pollIntervalMs: 5000 } }),
				},
			],
			"modern",
		);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
			backgroundCall,
		});
		await tools[0].execute("1", {}, never);
		await close();
		const moved = { ...server("s"), url: "https://s.example.com/v2/mcp" };
		const poll = () =>
			pollMcpTask(moved, started[0].reference, {
				fetch: fake.fetch,
				timeoutMs: 1000,
			});

		expect(await poll()).toEqual({ status: "working", pollIntervalMs: 5000 });
		Object.assign(fake.tasks.get("task-1") ?? {}, {
			status: "completed",
			result: {
				content: [{ type: "text", text: "x".repeat(100_000) }],
				isError: true,
			},
		});
		const done = await poll();
		expect(done).toMatchObject({ status: "completed", isError: true });
		const text = done.status === "completed" ? done.content[0] : undefined;
		expect(text?.type === "text" && text.text.length).toBeLessThan(100_000);
		expect(fake.requests.filter((r) => r.method === "tasks/get")).toHaveLength(
			2,
		);
		expect(fake.requests.map((r) => r.method)).not.toContain("tasks/cancel");
	});

	it("fails a call whose service asks for more input, as without Background Calls", async () => {
		const fake = fakeServer(
			[
				{
					name: "ask",
					inputSchema: { type: "object" },
					call: () => ({ inputRequired: true }),
				},
			],
			"modern",
		);
		const { tools, close } = await openToolbox(config("s"), ["mcp:s"], {
			signal: never,
			fetch: fake.fetch,
			backgroundCall,
		});
		await expect(tools[0].execute("1", {}, never)).rejects.toThrow(
			"This service asked for more input, which Orqestra does not support.",
		);
		await close();
	});
});
