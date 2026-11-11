import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Connections kept in a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { mcpServer } = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { config, connectionStore } = await import("./live.ts");
const { finishConnection, openToolbox, startConnection } = await import(
	"@orqestra/tools"
);
const { fakeAuthorizationServer, fakeMcpServer } = await import(
	"@orqestra/tools/testing"
);

const never = new AbortController().signal;

describe.skipIf(!url)("Connections in Postgres", () => {
	const reset = () => db.execute(sql`truncate mcp_server cascade`);
	beforeEach(reset);
	afterAll(async () => {
		await reset();
		await config.close();
	});

	it("refreshes once when two Runs meet an expired token together: the second uses the first's new token", async () => {
		const as = fakeAuthorizationServer();
		const github = {
			name: "GitHub",
			url: as.resource,
			headers: {},
			auth: "oauth" as const,
		};
		await db.insert(mcpServer).values({ ...github, id: "github", headers: [] });
		const mcp = as.guard(
			fakeMcpServer({
				tools: [
					{
						name: "echo",
						inputSchema: { type: "object" },
						call: () => ({ content: [{ type: "text", text: "ok" }] }),
					},
				],
			}).fetch,
		);
		const fetch = (input: string | URL, init?: RequestInit) =>
			new URL(input).origin === new URL(as.resource).origin
				? mcp(input, init)
				: as.fetch(input, init);
		const context = {
			userId: "ada",
			serverId: "github",
			server: github,
			store: connectionStore,
			orqestraUrl: "http://localhost:3000",
			fetch,
		};
		const started = await startConnection(context);
		if (!("url" in started)) throw new Error(started.detail);
		await finishConnection(
			{ ...context, server: async () => github },
			as.authorize(started.url),
		);

		const open = () =>
			openToolbox({ tools: {}, mcpServers: { github } }, ["mcp:github"], {
				signal: never,
				fetch,
				userId: "ada",
				connections: connectionStore,
			});
		const runs = await Promise.all([open(), open()]);
		as.accessTokens.clear();
		const results = await Promise.all(
			runs.map((r) => r.tools[0].execute("1", {}, never)),
		);
		expect(results.map((r) => r.content)).toEqual([
			[{ type: "text", text: "ok" }],
			[{ type: "text", text: "ok" }],
		]);
		expect(as.refreshed).toBe(1);
		const saved = await connectionStore.connection("ada", "github");
		expect(saved?.status).toBe("connected");
		expect(as.accessTokens.has(saved?.tokens?.access_token ?? "")).toBe(true);
		await Promise.all(runs.map((r) => r.close()));
	});
});
