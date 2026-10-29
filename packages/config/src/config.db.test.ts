import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Writes through the interface against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { sql } = await import("drizzle-orm");
const { config, liveConfig } = await import("./live.ts");
const { catalogProviders } = await import("./index.ts");

const general = {
	name: "General",
	description: "d",
	instructions: "",
	default: true,
};
const other = { name: "Other", description: "d", instructions: "" };
// nothing listens there, so the connection test fails fast
const mcp = (id: string) => ({
	id,
	create: true,
	name: id,
	url: "http://127.0.0.1:9/mcp",
	enabled: true,
	headers: [],
});

// a write reloads asynchronously in other processes
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 50; i++) {
		const value = await read();
		if (ok(value)) return value;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}

describe.skipIf(!url)("@orqestra/config writes (Postgres)", () => {
	// leaves only a default Agent, as the baseline does, also for the next package's tests
	const reset = async () => {
		await db.execute(
			sql`truncate provider, enabled_model, search_provider, tool_service, mcp_server, agent cascade`,
		);
		await config.agents.save({
			id: "general",
			create: true,
			definition: general,
		});
	};
	beforeEach(reset);
	afterAll(async () => {
		await reset();
		await config.close();
	});

	describe("Providers", () => {
		it("requires an API key on the first save", async () => {
			const result = await config.providers.save({
				id: "deepseek",
				apiKey: "",
				baseUrl: "https://api.deepseek.com",
			});
			expect(result.errors).toEqual({ apiKey: { code: "api_key_required" } });
			expect((await config.providers.list()).configured).toEqual([]);
		});

		it("stores no baseUrl when it is the Catalog's, and keeps the key when left blank", async () => {
			const catalog = (await catalogProviders()).find(
				(p) => p.id === "deepseek",
			);
			const baseUrl = `${catalog?.baseUrl}/`;
			expect(
				await config.providers.save({ id: "deepseek", apiKey: "sk", baseUrl }),
			).toEqual({ errors: {} });
			expect(
				await config.providers.save({ id: "deepseek", apiKey: "", baseUrl }),
			).toEqual({ errors: {} });
			expect((await config.providers.list()).configured).toEqual([
				{
					id: "deepseek",
					baseUrl: null,
					keyReadable: true,
					enabledModels: [],
				},
			]);
		});

		it("refuses to enable a Model that is not in the Catalog", async () => {
			await config.providers.save({
				id: "deepseek",
				apiKey: "sk",
				baseUrl: "http://10.0.0.1",
			});
			await expect(
				config.providers.setModelEnabled({
					providerId: "deepseek",
					modelId: "gone",
					enabled: true,
				}),
			).rejects.toThrow(/not in the Catalog/);
		});
	});

	describe("Search Providers", () => {
		it("keeps the stored key when left blank and the official baseUrl as none", async () => {
			const save = (apiKey: string) =>
				config.searchProviders.save({
					id: "tavily",
					apiKey,
					baseUrl: "https://api.tavily.com/",
				});
			expect(await save("tvly-1")).toEqual({ errors: {} });
			await config.searchProviders.serve("search", "tavily");
			expect(await save("")).toEqual({ errors: {} });
			expect((await config.current()).tools.search).toEqual({
				provider: "tavily",
				apiKey: "tvly-1",
				baseUrl: "https://api.tavily.com",
			});
			expect((await config.searchProviders.list()).configured).toEqual([
				{ id: "tavily", keyReadable: true, baseUrl: null },
			]);
		});

		it("requires an API key on the first save", async () => {
			expect(
				await config.searchProviders.save({
					id: "tavily",
					apiKey: "",
					baseUrl: "https://api.tavily.com",
				}),
			).toEqual({ errors: { apiKey: { code: "api_key_required" } } });
		});

		it("leaves its Tools unavailable once deleted", async () => {
			await config.searchProviders.save({
				id: "tavily",
				apiKey: "k",
				baseUrl: "https://api.tavily.com",
			});
			await config.searchProviders.serve("search", "tavily");
			await config.searchProviders.serve("scrape", "tavily");
			expect((await config.searchProviders.list()).available).toEqual([
				"search",
				"scrape",
			]);
			await config.searchProviders.delete("tavily");
			expect(await config.searchProviders.list()).toMatchObject({
				servedBy: { search: null, scrape: null },
				available: [],
			});
			expect((await config.agents.list()).availableTools).toEqual([]);
		});
	});

	describe("MCP Servers", () => {
		it("keeps a header's stored value when left blank, by name", async () => {
			const saved = await config.mcpServers.save({
				...mcp("docs"),
				headers: [{ name: "Authorization", value: "Bearer 1" }],
			});
			expect(saved).toMatchObject({
				errors: {},
				test: { ok: false, reason: "unreachable" },
			});
			await config.mcpServers.save({
				...mcp("docs"),
				create: false,
				headers: [{ name: "Authorization", value: "" }],
			});
			expect((await config.current()).mcpServers.docs.headers).toEqual({
				Authorization: "Bearer 1",
			});
			expect((await config.mcpServers.list())[0].headers).toEqual([
				{ name: "Authorization", readable: true },
			]);
		});

		it("returns field errors as codes", async () => {
			await config.mcpServers.save(mcp("docs"));
			expect((await config.mcpServers.save(mcp("docs"))).errors).toEqual({
				id: { code: "id_taken" },
			});
			expect((await config.mcpServers.save(mcp("Docs"))).errors).toEqual({
				id: { code: "id_invalid" },
			});
			expect(
				(
					await config.mcpServers.save({
						...mcp("x"),
						headers: [
							{ name: "A", value: "1" },
							{ name: "a", value: "2" },
						],
					})
				).errors,
			).toEqual({ headers: { code: "header_twice", header: "a" } });
		});

		it("is removed from every Agent Definition when deleted", async () => {
			await config.mcpServers.save(mcp("docs"));
			await config.mcpServers.save(mcp("files"));
			const tools = ["search", "mcp:docs", "mcp:files"];
			await config.agents.save({
				id: "general",
				create: false,
				definition: { ...general, tools },
			});
			await config.agents.save({
				id: "other",
				create: true,
				definition: { ...other, tools: ["mcp:docs"] },
			});
			await config.mcpServers.delete("docs");
			const { agents, mcpServers } = await config.agents.list();
			expect(agents.map((a) => [a.id, a.definition.tools])).toEqual([
				["general", ["search", "mcp:files"]],
				["other", []],
			]);
			expect(mcpServers).toEqual([{ id: "files", name: "files" }]);
		});
	});

	describe("Agent Definitions", () => {
		it("lets a new default Agent take over from the old one", async () => {
			await config.agents.save({
				id: "other",
				create: true,
				definition: { ...other, default: true },
			});
			const { agents } = await config.agents.list();
			expect(agents.map((a) => [a.id, a.definition.default])).toEqual([
				["general", false],
				["other", true],
			]);
			expect((await config.current()).defaultAgent.id).toBe("other");
		});

		it("refuses to delete the default Agent or to unset it", async () => {
			await expect(config.agents.delete("general")).rejects.toThrow(
				/default Agent cannot be deleted/,
			);
			expect(
				await config.agents.save({
					id: "general",
					create: false,
					definition: { ...general, default: false },
				}),
			).toEqual({ errors: { default: { code: "default_required" } } });
		});

		it("returns invalid fields as codes, keeping zod's message as detail", async () => {
			const { errors } = await config.agents.save({
				id: "x",
				create: true,
				definition: { ...other, name: "" },
			});
			expect(errors).toEqual({
				name: { code: "invalid", detail: expect.any(String) },
			});
			expect(
				(
					await config.agents.save({
						id: "general",
						create: true,
						definition: general,
					})
				).errors,
			).toEqual({ id: { code: "id_taken" } });
			expect(
				(
					await config.agents.save({
						id: "x",
						create: true,
						definition: { ...other, models: ["a/b"], defaultModel: "a/c" },
					})
				).errors,
			).toEqual({
				defaultModel: { code: "default_model_not_allowed", model: "a/c" },
			});
		});
	});

	it("tells every other process to reload after a write", async () => {
		const elsewhere = liveConfig();
		try {
			expect((await elsewhere.get()).agents.map((a) => a.id)).toEqual([
				"general",
			]);
			await config.agents.save({
				id: "other",
				create: true,
				definition: other,
			});
			await eventually(
				() => elsewhere.get(),
				(c) => c.agents.some((a) => a.id === "other"),
			);
		} finally {
			await elsewhere.close();
		}
	});
});
