import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
	type Conversations,
	createConversations,
} from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { backgroundCall, conversation, message } from "@orqestra/db/schema";
import { fakeMcpServer } from "@orqestra/mcp/testing";
import { catalogProviders } from "@orqestra/models";
import { memoryStore } from "@orqestra/tools/testing";
import { eq, sql } from "drizzle-orm";
import { createApp } from "./app.ts";
import { createCapabilities } from "./capabilities.ts";

const config = createCapabilities(db);

// Through the api against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;

const api = createApp({
	config: config,
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
			sql`truncate provider, enabled_model, search_provider, tool_service, mcp_server, sandbox_provider, document_parser, agent, skill, limits cascade`,
		);
		// the Tools' config reloads on its own channel, which a truncate does not notify
		await config.tools.sandboxProvider.delete();
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
			{
				id,
				baseUrl: null,
				keyReadable: true,
				enabledModels: [
					{
						id: models[0].id,
						cost: (await catalogProviders())[0].models[0].cost,
						source: "catalog",
					},
				],
			},
		]);
		await call("DELETE", `/providers/${id}`);
		expect((await call("GET", "/providers")).body.configured).toEqual([]);
	});

	describe("a Model's price", () => {
		const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
		let id: string;
		let modelId: string;
		let catalogCost: unknown;
		beforeEach(async () => {
			const [first] = await catalogProviders();
			({ id } = first);
			({ id: modelId, cost: catalogCost } = first.models[0]);
			await call("POST", "/providers", {
				id,
				apiKey: "k",
				baseUrl: first.baseUrl,
			});
		});
		const enable = (enabled: boolean) =>
			call("PUT", "/providers/models", { providerId: id, modelId, enabled });
		const price = (cost: unknown) =>
			call("PUT", "/providers/models/price", { providerId: id, modelId, cost });
		const enabledModels = async () =>
			(await call("GET", "/providers")).body.configured[0]?.enabledModels;

		it("is refused for a Model that is not enabled", async () => {
			expect(await price(cost)).toEqual({
				status: 422,
				body: { errors: { modelId: { code: "model_not_enabled" } } },
			});
			await enable(true);
			expect(await enabledModels()).toEqual([
				{ id: modelId, cost: catalogCost, source: "catalog" },
			]);
		});

		it("replaces the Catalog's as a whole, and clearing it goes back to the Catalog's", async () => {
			await enable(true);
			expect((await price(cost)).status).toBe(200);
			expect(await enabledModels()).toEqual([
				{ id: modelId, cost, source: "custom" },
			]);
			expect((await price(null)).status).toBe(200);
			expect(await enabledModels()).toEqual([
				{ id: modelId, cost: catalogCost, source: "catalog" },
			]);
		});

		it("is refused when negative", async () => {
			await enable(true);
			expect((await price({ ...cost, output: -1 })).status).toBe(422);
		});

		it("is kept while the Model is disabled, and in force again once it is re-enabled", async () => {
			await enable(true);
			await price(cost);
			await enable(false);
			expect(await enabledModels()).toEqual([]);
			await enable(true);
			expect(await enabledModels()).toEqual([
				{ id: modelId, cost, source: "custom" },
			]);
		});

		it("goes with its Provider", async () => {
			await enable(true);
			await price(cost);
			await call("DELETE", `/providers/${id}`);
			await call("POST", "/providers", {
				id,
				apiKey: "k",
				baseUrl: "https://x.test",
			});
			await enable(true);
			expect(await enabledModels()).toEqual([
				{ id: modelId, cost: catalogCost, source: "catalog" },
			]);
		});
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

	it("deletes a disabled MCP Server, cancelling its Background Calls and ending them failed", async () => {
		const fake = fakeMcpServer({ era: "modern" });
		const withCalls = createApp({
			config: config,
			session: async () => ({
				user: { id: "a1", name: "Ada", admin: true },
				cookies: [],
			}),
			auth: () => new Response(null, { status: 404 }),
			conversations: createConversations({
				store: memoryStore().store,
				capabilities: config,
				fetch: fake.fetch,
			}),
		});
		const url = "http://127.0.0.1:9/mcp";
		await call("POST", "/mcp-servers", {
			id: "docs",
			create: true,
			name: "Docs",
			url,
			enabled: true,
			headers: [],
		});
		await call("PUT", "/mcp-servers/enabled", { id: "docs", enabled: false });
		const [conv] = await db
			.insert(conversation)
			.values({ userId: "a1" })
			.returning();
		try {
			const [said] = await db
				.insert(message)
				.values({
					conversationId: conv.id,
					message: { role: "user", content: "crunch", timestamp: 0 },
					model: "faux/faux-1",
					thinkingLevel: "off",
				})
				.returning();
			await db.insert(backgroundCall).values({
				conversationId: conv.id,
				toolCallId: "t1",
				mcpServerId: "docs",
				toolName: "crunch",
				reference: {
					endpointId: url,
					generation: "v2",
					taskId: "task-1",
					originalOperation: "tools/call",
				},
				jobId: "j1",
				messageId: said.id,
			});
			const response = await withCalls.handle(
				new Request("http://localhost/api/mcp-servers/docs", {
					method: "DELETE",
				}),
			);
			expect(response.status).toBe(200);
			const [ended] = await db
				.select({ status: backgroundCall.status })
				.from(backgroundCall)
				.where(eq(backgroundCall.conversationId, conv.id));
			expect(ended.status).toBe("failed");
			expect(fake.requests.map((r) => r.method)).toContain("tasks/cancel");
			expect((await call("GET", "/mcp-servers")).body).toEqual([]);
		} finally {
			await db.delete(conversation).where(eq(conversation.id, conv.id));
		}
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

	it("saves the Document Parser with its connection test, and deletes it", async () => {
		expect((await call("GET", "/document-parser")).body).toEqual({
			parser: null,
		});
		const { body } = await call("POST", "/document-parser", {
			enabled: true,
			url: "http://127.0.0.1:9",
			apiKey: "k",
		});
		expect(body).toMatchObject({
			errors: {},
			test: { ok: false, reason: "unreachable" },
		});
		expect((await call("GET", "/document-parser")).body.parser).toEqual({
			enabled: true,
			url: "http://127.0.0.1:9",
			keyReadable: true,
		});
		await call("DELETE", "/document-parser");
		expect((await call("GET", "/document-parser")).body.parser).toBeNull();
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
