import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { config } from "@orqestra/config/live";
import type { Conversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { sql } from "drizzle-orm";
import { createApp } from "./app.ts";

// Through the api against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;

const api = createApp({
	session: async () => ({
		user: { id: "a1", name: "Ada", admin: true },
		cookies: [],
	}),
	auth: () => new Response(null, { status: 404 }),
	conversations: {} as Conversations,
});

async function call(method: string, path: string, body?: unknown) {
	const response = await api.handle(
		new Request(`http://localhost/api${path}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe.skipIf(!url)("the console through the api", () => {
	// leaves only a default Agent, as the baseline does, also for the next package's tests
	const reset = async () => {
		await db.execute(
			sql`truncate provider, enabled_model, search_provider, tool_service, mcp_server, sandbox_provider, agent, skill, limits cascade`,
		);
		await config.agents.save({
			id: "general",
			create: true,
			definition: {
				name: "General",
				description: "d",
				instructions: "",
				default: true,
			},
		});
	};
	beforeEach(reset);
	afterAll(reset);

	it("saves a Provider, enables one of its Models and deletes it", async () => {
		const { catalog } = (await call("GET", "/providers")).body;
		const [{ id, baseUrl, models }] = catalog;
		expect(
			await call("POST", "/providers", { id, apiKey: "k", baseUrl }),
		).toEqual({ status: 200, body: { errors: {} } });
		await call("PUT", "/providers/models", {
			providerId: id,
			modelId: models[0].id,
			enabled: true,
		});
		expect((await call("GET", "/providers")).body.configured).toEqual([
			{ id, baseUrl: null, keyReadable: true, enabledModels: [models[0].id] },
		]);
		await call("DELETE", `/providers/${id}`);
		expect((await call("GET", "/providers")).body.configured).toEqual([]);
	});

	it("is 422 with a save's field errors", async () => {
		expect(
			await call("POST", "/providers", {
				id: "nope",
				baseUrl: "https://x.test",
			}),
		).toEqual({
			status: 422,
			body: { errors: { id: { code: "not_in_catalog" } } },
		});
	});

	it("saves a Search Provider and picks it for a Tool", async () => {
		await call("POST", "/search-providers", {
			id: "tavily",
			apiKey: "k",
			baseUrl: "https://api.tavily.com",
		});
		await call("PUT", "/search-providers/tools", {
			tool: "search",
			provider: "tavily",
		});
		const { body } = await call("GET", "/search-providers");
		expect(body.configured.map((p: { id: string }) => p.id)).toEqual([
			"tavily",
		]);
		expect(body.servedBy).toMatchObject({ search: "tavily" });
	});

	it("saves an MCP Server, with its connection test, and disables it", async () => {
		const { status, body } = await call("POST", "/mcp-servers", {
			id: "docs",
			create: true,
			name: "Docs",
			// nothing listens there, so the test fails fast
			url: "http://127.0.0.1:9/mcp",
			enabled: true,
			headers: [],
		});
		expect(status).toBe(200);
		expect(body.errors).toEqual({});
		expect(body.test).toBeDefined();
		await call("PUT", "/mcp-servers/enabled", { id: "docs", enabled: false });
		expect((await call("GET", "/mcp-servers")).body).toMatchObject([
			{ id: "docs", enabled: false },
		]);
	});

	it("saves the Sandbox Provider and deletes it", async () => {
		expect((await call("GET", "/sandbox-provider")).body).toEqual({
			provider: null,
		});
		await call("POST", "/sandbox-provider", {
			url: "http://127.0.0.1:9",
			token: "t",
			snapshot: "",
			cpu: 1,
			memory: 1024,
		});
		expect(
			(await call("GET", "/sandbox-provider")).body.provider,
		).toMatchObject({ url: "http://127.0.0.1:9", tokenReadable: true });
		await call("DELETE", "/sandbox-provider");
		expect((await call("GET", "/sandbox-provider")).body.provider).toBeNull();
	});

	it("saves the Limits, refusing a Subagent depth past 3", async () => {
		const { limits } = (await call("GET", "/limits")).body;
		expect(limits.maxSubagentDepth).toBe(2);
		expect(
			await call("PUT", "/limits", { ...limits, unattendedMaxSteps: 7 }),
		).toEqual({ status: 200, body: { errors: {} } });
		expect((await call("GET", "/limits")).body.limits).toEqual({
			...limits,
			unattendedMaxSteps: 7,
		});
		const refused = await call("PUT", "/limits", {
			...limits,
			maxSubagentDepth: 4,
		});
		expect(refused.status).toBe(422);
		expect(Object.keys(refused.body.errors)).toEqual(["maxSubagentDepth"]);
	});

	it("saves an Agent Definition and deletes it", async () => {
		const definition = { name: "Other", description: "d", instructions: "" };
		const ids = async () =>
			(await call("GET", "/agents")).body.agents.map(
				(a: { id: string }) => a.id,
			);
		expect(
			await call("POST", "/agents", { id: "other", create: true, definition }),
		).toEqual({ status: 200, body: { errors: {} } });
		expect(await ids()).toEqual(["general", "other"]);
		await call("DELETE", "/agents/other");
		expect(await ids()).toEqual(["general"]);
	});
});
