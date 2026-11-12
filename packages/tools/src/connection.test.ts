import { describe, expect, it } from "vitest";
import { probeMcpServer, testMcpServer } from "./index.ts";
import {
	fakeAuthorizationServer,
	fakeMcpServer,
	type McpEra,
} from "./testing.ts";

const server = {
	name: "Docs",
	url: "http://mcp.internal/mcp",
	headers: { Authorization: "Bearer s3cret" },
};

const tools = [
	{
		name: "search_docs",
		description: "Search the docs",
		inputSchema: { type: "object" as const },
	},
	{ name: "no_description", inputSchema: { type: "object" as const } },
];

describe("MCP Server connection test", () => {
	it.each<McpEra>([
		"legacy",
		"dual",
		"modern",
	])("lists the Tools of a %s server by name and description, sending the server's headers on every request", async (era) => {
		const fake = fakeMcpServer({ era, tools });
		const result = await testMcpServer(server, { fetch: fake.fetch });
		expect(result).toEqual({
			ok: true,
			tools: [
				{ name: "search_docs", description: "Search the docs" },
				{ name: "no_description", description: undefined },
			],
		});
		expect(fake.requests.map((r) => r.method)).toContain("tools/list");
		for (const r of fake.requests) {
			expect(r.url).toBe("http://mcp.internal/mcp");
			expect(r.headers.get("authorization")).toBe("Bearer s3cret");
		}
	});

	it("talks 2026-07-28 to a server that speaks both", async () => {
		const fake = fakeMcpServer({ era: "dual", tools });
		await testMcpServer(server, { fetch: fake.fetch });
		expect(fake.requests.map((r) => r.method)).not.toContain("initialize");
	});

	it("says which versions a server supports when Orqestra speaks none of them", async () => {
		const fake = fakeMcpServer({ era: "modern", tools });
		fake.supported = ["2027-03-01", "2027-09-01"];
		const result = await testMcpServer(server, { fetch: fake.fetch });
		expect(result).toEqual({
			ok: false,
			reason: "failed",
			detail: "服务器只支持 MCP 2027-03-01, 2027-09-01",
		});
	});

	it("reports rejected credentials as an authentication failure", async () => {
		for (const status of [401, 403]) {
			const fake = fakeMcpServer({ tools });
			fake.status = status;
			const result = await testMcpServer(server, { fetch: fake.fetch });
			expect(result).toMatchObject({ ok: false, reason: "auth" });
		}
	});

	it("reports a server it cannot reach", async () => {
		const fake = fakeMcpServer({ tools });
		fake.down = true;
		const result = await testMcpServer(server, { fetch: fake.fetch });
		expect(result).toMatchObject({ ok: false, reason: "unreachable" });
	});

	it("reports other HTTP failures with their detail", async () => {
		const fake = fakeMcpServer({ tools });
		fake.status = 500;
		const result = await testMcpServer(server, { fetch: fake.fetch });
		expect(result).toMatchObject({ ok: false, reason: "failed" });
		expect(result.ok || result.detail).toContain("500");
	});

	it("gives up on a server that does not answer in time", async () => {
		const fake = fakeMcpServer({ tools });
		fake.delayMs = 10_000;
		const result = await testMcpServer(server, {
			fetch: fake.fetch,
			timeoutMs: 50,
		});
		expect(result).toMatchObject({ ok: false, reason: "timeout" });
	});

	it("gives connecting and listing one deadline together", async () => {
		const fake = fakeMcpServer({ tools });
		fake.delayMs = 40;
		const result = await testMcpServer(server, {
			fetch: fake.fetch,
			timeoutMs: 60,
		});
		expect(result).toMatchObject({ ok: false, reason: "timeout" });
	});
});

describe("MCP Server probe", () => {
	const as = fakeAuthorizationServer({ resource: server.url });
	const probe = (fetch: typeof as.fetch, headers = {}, preRegistered = false) =>
		probeMcpServer({ url: server.url, headers, preRegistered }, { fetch });

	it("is shared when it lists its Tools", async () => {
		const fake = fakeMcpServer({ tools });
		expect(await probe(fake.fetch)).toMatchObject({
			auth: "shared",
			test: { ok: true },
		});
	});

	it("is per-User OAuth when it refuses Orqestra and names its authorization server", async () => {
		expect(await probe(as.fetch)).toEqual({
			auth: "oauth",
			test: { ok: true, authorizationServer: as.issuer },
		});
	});

	it("is shared when it refuses the Authorization header it was given, or has no OAuth metadata", async () => {
		expect(
			await probe(as.fetch, { Authorization: "Bearer wrong" }),
		).toMatchObject({ auth: "shared", test: { ok: false, reason: "auth" } });
		const fake = fakeMcpServer({ tools });
		fake.status = 401;
		expect(await probe(fake.fetch)).toMatchObject({
			auth: "shared",
			test: { ok: false, reason: "auth" },
		});
	});

	it("is per-User OAuth with a pre-registered Client, whatever it answers", async () => {
		const fake = fakeMcpServer({ tools });
		expect(await probe(fake.fetch, {}, true)).toMatchObject({
			auth: "oauth",
			test: { ok: false },
		});
	});

	it("cannot tell when it does not answer", async () => {
		const fake = fakeMcpServer({ tools });
		fake.down = true;
		expect(await probe(fake.fetch)).toEqual({
			test: expect.objectContaining({ ok: false, reason: "unreachable" }),
		});
	});
});
