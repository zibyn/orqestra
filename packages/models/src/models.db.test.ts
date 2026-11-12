import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Writes through the interface against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
const { drizzle } = await import("drizzle-orm/node-postgres");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { catalogProviders, createModels } = await import("./index.ts");
const db = drizzle(url as string, { schema });
const models = createModels(db);

// a write reloads asynchronously in other processes
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 50; i++) {
		const value = await read();
		if (ok(value)) return value;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}

describe.skipIf(!url)("@orqestra/models writes (Postgres)", () => {
	const reset = () =>
		db.execute(sql`truncate provider, enabled_model, model_price cascade`);
	beforeEach(reset);
	afterAll(async () => {
		await reset();
		await models.close();
		await db.$client.end();
	});

	describe("Providers", () => {
		it("requires an API key on the first save", async () => {
			const result = await models.providers.save({
				id: "deepseek",
				apiKey: "",
				baseUrl: "https://api.deepseek.com",
			});
			expect(result.errors).toEqual({ apiKey: { code: "api_key_required" } });
			expect((await models.providers.list()).configured).toEqual([]);
		});

		it("stores no baseUrl when it is the Catalog's, and keeps the key when left blank", async () => {
			const catalog = (await catalogProviders()).find(
				(p) => p.id === "deepseek",
			);
			const baseUrl = `${catalog?.baseUrl}/`;
			expect(
				await models.providers.save({ id: "deepseek", apiKey: "sk", baseUrl }),
			).toEqual({ errors: {} });
			expect(
				await models.providers.save({ id: "deepseek", apiKey: "", baseUrl }),
			).toEqual({ errors: {} });
			expect((await models.providers.list()).configured).toEqual([
				{
					id: "deepseek",
					baseUrl: null,
					keyReadable: true,
					enabledModels: [],
				},
			]);
		});

		it("refuses to enable a Model that is not in the Catalog", async () => {
			await models.providers.save({
				id: "deepseek",
				apiKey: "sk",
				baseUrl: "http://10.0.0.1",
			});
			await expect(
				models.providers.setModelEnabled({
					providerId: "deepseek",
					modelId: "gone",
					enabled: true,
				}),
			).rejects.toThrow(/not in the Catalog/);
		});
	});

	it("tells every other process to reload after a write", async () => {
		// another pool, as another process
		const other = drizzle(url as string, { schema });
		const elsewhere = createModels(other);
		try {
			expect((await elsewhere.current()).models).toEqual([]);
			await models.providers.save({
				id: "deepseek",
				apiKey: "sk",
				baseUrl: "http://10.0.0.1",
			});
			await models.providers.setModelEnabled({
				providerId: "deepseek",
				modelId: "deepseek-flash",
				enabled: true,
			});
			const loaded = await eventually(
				() => elsewhere.current(),
				(m) => m.models.length > 0,
			);
			expect(loaded.models[0]).toMatchObject({
				id: "deepseek-flash",
				baseUrl: "http://10.0.0.1",
			});
		} finally {
			await elsewhere.close();
			await other.$client.end();
		}
	});
});
