import { describe, expect, it } from "vitest";
import { testMcpServer } from "./mcp.ts";

const server = {
	name: "Docs",
	url: "http://mcp.internal/mcp",
	headers: { Authorization: "Bearer s3cret" },
};

const tools = [
	{ name: "search_docs", description: "Search the docs", inputSchema: {} },
	{ name: "no_description", inputSchema: {} },
];

/** A Streamable HTTP MCP Server answering in JSON; records what it was sent. */
function fakeServer(
	opts: { status?: number; listTools?: () => unknown; delayMs?: number } = {},
) {
	const requests: { url: string; headers: Headers; method?: string }[] = [];
	const fetch = async (input: string | URL, init?: RequestInit) => {
		const message = init?.body ? JSON.parse(String(init.body)) : {};
		requests.push({
			url: String(input),
			headers: new Headers(init?.headers),
			method: message.method,
		});
		if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
		if (opts.status) return new Response("nope", { status: opts.status });
		if (!("id" in message)) return new Response(null, { status: 202 });
		const result =
			message.method === "initialize"
				? {
						protocolVersion: message.params.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "fake", version: "1" },
					}
				: message.method === "tools/list"
					? (opts.listTools?.() ?? { tools })
					: {};
		if (result instanceof Promise)
			await new Promise((_, reject) =>
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				),
			);
		return Response.json({ jsonrpc: "2.0", id: message.id, result });
	};
	return { fetch, requests };
}

describe("MCP Server connection test", () => {
	it("lists the Tools by name and description, using the server's URL and headers", async () => {
		const fake = fakeServer();
		const result = await testMcpServer(server, { fetch: fake.fetch });
		expect(result).toEqual({
			ok: true,
			tools: [
				{ name: "search_docs", description: "Search the docs" },
				{ name: "no_description", description: undefined },
			],
		});
		const list = fake.requests.find((r) => r.method === "tools/list");
		expect(list?.url).toBe("http://mcp.internal/mcp");
		expect(list?.headers.get("authorization")).toBe("Bearer s3cret");
	});

	it("reports rejected credentials as an authentication failure", async () => {
		for (const status of [401, 403]) {
			const result = await testMcpServer(server, {
				fetch: fakeServer({ status }).fetch,
			});
			expect(result).toMatchObject({ ok: false, reason: "auth" });
		}
	});

	it("reports a server it cannot reach", async () => {
		const result = await testMcpServer(server, {
			fetch: () => Promise.reject(new TypeError("fetch failed")),
		});
		expect(result).toMatchObject({ ok: false, reason: "unreachable" });
	});

	it("reports other HTTP failures with their detail", async () => {
		const result = await testMcpServer(server, {
			fetch: fakeServer({ status: 500 }).fetch,
		});
		expect(result).toMatchObject({ ok: false, reason: "failed" });
		expect(result.ok || result.detail).toContain("500");
	});

	it("gives up on a server that does not answer in time", async () => {
		const result = await testMcpServer(server, {
			fetch: fakeServer({ listTools: () => new Promise(() => {}) }).fetch,
			timeoutMs: 50,
		});
		expect(result).toMatchObject({ ok: false, reason: "timeout" });
	});

	it("gives connecting and listing one deadline together", async () => {
		const result = await testMcpServer(server, {
			fetch: fakeServer({ delayMs: 40 }).fetch,
			timeoutMs: 60,
		});
		expect(result).toMatchObject({ ok: false, reason: "timeout" });
	});
});
