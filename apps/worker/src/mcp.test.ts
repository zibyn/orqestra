import { describe, expect, it } from "bun:test";
import type {
	CallToolResult,
	JsonRpcMessage,
	Tool,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { OrqestraConfig } from "@orqestra/config";
import { mcpTools } from "./mcp.ts";

type Call = (
	args: Record<string, unknown>,
) => CallToolResult | Promise<CallToolResult>;

/** A tiny scripted MCP Server: answers initialize, tools/list and tools/call from `tools`. */
function fakeServer(tools: (Tool & { call?: Call })[]) {
	const { client, server } = createInMemoryTransportPair();
	const state = { closed: false, cancelled: 0 };
	server.onClose(() => {
		state.closed = true;
	});
	const reply = (id: unknown, result: unknown) =>
		server.send({ jsonrpc: "2.0", id, result } as JsonRpcMessage);
	server.onMessage(async (message) => {
		const m = message as {
			id?: string | number;
			method?: string;
			params?: Record<string, unknown>;
		};
		if (m.method === "notifications/cancelled") state.cancelled++;
		if (m.id === undefined || !m.method) return;
		if (m.method === "initialize")
			return reply(m.id, {
				protocolVersion: m.params?.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "fake", version: "1" },
			});
		if (m.method === "tools/list")
			return reply(m.id, {
				tools: tools.map(({ call: _, ...t }) => t),
			});
		if (m.method === "tools/call") {
			const tool = tools.find((t) => t.name === m.params?.name);
			const result = await tool?.call?.(
				(m.params?.arguments ?? {}) as Record<string, unknown>,
			);
			// a closed transport cannot send the reply of a call that was given up on
			return reply(m.id, result).catch(() => {});
		}
	});
	void server.start();
	return { transport: client, state };
}

const server = (id: string) => ({
	name: id,
	url: `https://${id}.example.com/mcp`,
	headers: {},
});
const config = (...ids: string[]) =>
	({
		mcpServers: Object.fromEntries(ids.map((id) => [id, server(id)])),
	}) as unknown as OrqestraConfig;

const echo: Tool & { call: Call } = {
	name: "echo",
	inputSchema: { type: "object" },
	call: ({ text }) => ({ content: [{ type: "text", text: String(text) }] }),
};
const never = new AbortController().signal;

describe("mcpTools", () => {
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
		const { tools, close } = await mcpTools(
			config("github", "wiki", "other"),
			["search", "mcp:github", "mcp:wiki", "mcp:gone"],
			never,
			{ transport: (id) => fakes[id as keyof typeof fakes].transport },
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
		const { tools, close } = await mcpTools(config("s"), ["mcp:s"], never, {
			transport: () => fake.transport,
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
		const { tools, close } = await mcpTools(config("s"), ["mcp:s"], never, {
			transport: () => fake.transport,
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
		const down = createInMemoryTransportPair().client; // nobody answers on the other end
		const { tools, close } = await mcpTools(
			config("down", "up"),
			["mcp:down", "mcp:up"],
			never,
			{
				transport: (id) => (id === "up" ? up.transport : down),
				timeoutMs: 50,
			},
		);
		expect(tools.map((t) => t.name)).toEqual(["up__echo"]);
		const result = await tools[0].execute("1", { text: "hi" }, never);
		expect(result.content).toEqual([{ type: "text", text: "hi" }]);
		await close();
	});

	it("stops connecting when the Run stops", async () => {
		const { client, server } = createInMemoryTransportPair();
		void server.start(); // listening, but never answers
		const stop = new AbortController();
		const connecting = mcpTools(config("s"), ["mcp:s"], stop.signal, {
			transport: () => client,
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
		const { tools, close } = await mcpTools(config("s"), ["mcp:s"], never, {
			transport: () => fake.transport,
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
		const { tools, close } = await mcpTools(config("s"), ["mcp:s"], never, {
			transport: () => fake.transport,
			timeoutMs: 50,
		});
		await expect(tools[0].execute("1", {}, never)).rejects.toThrow(/time/i);
		await close();
	});

	it("closes every connection when done", async () => {
		const a = fakeServer([echo]);
		const b = fakeServer([echo]);
		const { close } = await mcpTools(
			config("a", "b"),
			["mcp:a", "mcp:b"],
			never,
			{
				transport: (id) => (id === "a" ? a : b).transport,
			},
		);
		expect(a.state.closed || b.state.closed).toBe(false);
		await close();
		expect([a.state.closed, b.state.closed]).toEqual([true, true]);
	});
});
