import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Writes through the interface against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { sql } = await import("drizzle-orm");
const { availableTools } = await import("./index.ts");
const { createTools } = await import("./live.ts");
const tools = createTools(db);
/** The Tools the Agent form offers, without MCP Servers. */
const offered = async () =>
	availableTools({ ...(await tools.current()), mcpServers: {} });

describe.skipIf(!url)("@orqestra/tools writes (Postgres)", () => {
	const reset = () =>
		tools.write((tx) =>
			tx.execute(
				sql`truncate search_provider, tool_service, sandbox_provider, document_parser cascade`,
			),
		);
	beforeEach(reset);
	afterAll(async () => {
		await reset();
		await tools.close();
	});

	describe("Search Providers", () => {
		it("keeps the stored key when left blank and the official baseUrl as none", async () => {
			const save = (apiKey: string) =>
				tools.searchProviders.save({
					id: "tavily",
					apiKey,
					baseUrl: "https://api.tavily.com/",
				});
			expect(await save("tvly-1")).toEqual({ errors: {} });
			await tools.searchProviders.serve("search", "tavily");
			expect(await save("")).toEqual({ errors: {} });
			expect((await tools.current()).tools.search).toEqual({
				provider: "tavily",
				apiKey: "tvly-1",
				baseUrl: "https://api.tavily.com",
			});
			expect((await tools.searchProviders.list()).configured).toEqual([
				{ id: "tavily", keyReadable: true, baseUrl: null },
			]);
		});

		it("requires an API key on the first save", async () => {
			expect(
				await tools.searchProviders.save({
					id: "tavily",
					apiKey: "",
					baseUrl: "https://api.tavily.com",
				}),
			).toEqual({ errors: { apiKey: { code: "api_key_required" } } });
		});

		it("leaves its Tools unavailable once deleted", async () => {
			await tools.searchProviders.save({
				id: "tavily",
				apiKey: "k",
				baseUrl: "https://api.tavily.com",
			});
			await tools.searchProviders.serve("search", "tavily");
			await tools.searchProviders.serve("scrape", "tavily");
			expect((await tools.searchProviders.list()).available).toEqual([
				"search",
				"scrape",
			]);
			await tools.searchProviders.delete("tavily");
			expect(await tools.searchProviders.list()).toMatchObject({
				servedBy: { search: null, scrape: null },
				available: [],
			});
			expect(await offered()).toEqual([]);
		});
	});

	describe("Sandbox Provider", () => {
		// nothing listens there, so the connection test fails fast
		const orrery = {
			url: "http://127.0.0.1:9",
			token: "orr_1_s",
			snapshot: "",
			cpu: 2,
			memory: 2147483648,
		};

		it("requires a token on the first save", async () => {
			expect(
				await tools.sandboxProvider.save({ ...orrery, token: "" }),
			).toEqual({ errors: { token: { code: "token_required" } } });
			expect(await tools.sandboxProvider.get()).toBeNull();
		});

		it("is saved even when the connection test fails, and keeps the token when left blank", async () => {
			const saved = await tools.sandboxProvider.save(orrery);
			expect(saved).toMatchObject({
				errors: {},
				test: { ok: false, reason: "unreachable" },
			});
			await tools.sandboxProvider.save({
				...orrery,
				token: "",
				snapshot: "skills",
				cpu: 4,
			});
			expect(await tools.sandboxProvider.get()).toEqual({
				url: "http://127.0.0.1:9",
				tokenReadable: true,
				snapshot: "skills",
				cpu: 4,
				memory: 2147483648,
			});
			expect((await tools.current()).sandboxProvider).toEqual({
				url: "http://127.0.0.1:9",
				token: "orr_1_s",
				snapshot: "skills",
				cpu: 4,
				memory: 2147483648,
			});
		});

		it("is unavailable once deleted", async () => {
			await tools.sandboxProvider.save(orrery);
			await tools.sandboxProvider.delete();
			expect(await tools.sandboxProvider.get()).toBeNull();
			expect((await tools.current()).sandboxProvider).toBeUndefined();
		});
	});

	describe("Document Parser", () => {
		// nothing listens there, so the connection test fails fast
		const selfHosted = { enabled: true, url: "http://127.0.0.1:9", apiKey: "" };

		it("requires a key for mineru.net", async () => {
			expect(
				await tools.documentParser.save({
					enabled: true,
					url: "https://mineru.net",
					apiKey: "",
				}),
			).toEqual({ errors: { apiKey: { code: "api_key_required" } } });
			expect(await tools.documentParser.get()).toBeNull();
		});

		it("serves Parse from a self-hosted MinerU without a key, saved even when the connection test fails", async () => {
			expect(await tools.documentParser.save(selfHosted)).toMatchObject({
				errors: {},
				test: { ok: false, reason: "unreachable" },
			});
			expect(await tools.documentParser.get()).toEqual({
				enabled: true,
				url: "http://127.0.0.1:9",
				keyReadable: null,
			});
			expect((await tools.current()).tools.parse).toEqual({
				baseUrl: "http://127.0.0.1:9",
				apiKey: "",
			});
		});

		it("stores the key encrypted and keeps it when left blank", async () => {
			await tools.documentParser.save({ ...selfHosted, apiKey: "mk" });
			await tools.documentParser.save(selfHosted);
			const [row] = (await db.execute(sql`select api_key from document_parser`))
				.rows as { api_key: string }[];
			expect(row.api_key).not.toContain("mk");
			expect(await tools.documentParser.get()).toMatchObject({
				keyReadable: true,
			});
			expect((await tools.current()).tools.parse?.apiKey).toBe("mk");
		});

		it("leaves Parse unavailable while disabled, and once deleted", async () => {
			await tools.documentParser.save({ ...selfHosted, enabled: false });
			expect((await tools.current()).tools.parse).toBeUndefined();
			expect(await offered()).not.toContain("parse");
			await tools.documentParser.save(selfHosted);
			expect(await offered()).toContain("parse");
			await tools.documentParser.delete();
			expect(await tools.documentParser.get()).toBeNull();
			expect((await tools.current()).tools.parse).toBeUndefined();
		});
	});
});
