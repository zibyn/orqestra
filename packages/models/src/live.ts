import type { Db } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import { enabledModel, modelPrice, provider } from "@orqestra/db/schema";
import {
	decryptSecret,
	encryptionKey,
	sealSecret,
	secretReadable,
} from "@orqestra/db/secret";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
	catalogProviders,
	type ModelSettings,
	modelRef,
	priceInForce,
	pricesByModel,
	resolveModels,
	testConnection,
} from "./index.ts";

/** NOTIFY channel, no payload: Providers, enabled Models or prices changed, reload them. */
const MODELS_CHANNEL = "models_changed";

/** Field errors by name, as SaveErrors; empty when it was saved. */
type Errors = Record<
	string,
	{ code: "api_key_required" | "not_in_catalog" | "model_not_enabled" }
>;

const httpUrl = z.url({ protocol: /^https?$/ });

export const providerInput = z.object({
	id: z.string().min(1),
	// blank keeps the stored key
	apiKey: z.string().trim().optional(),
	// the Catalog's baseUrl, or another endpoint for the same API
	baseUrl: httpUrl,
});
export const providerTestInput = providerInput.extend({ modelId: z.string() });
export const modelEnabledInput = z.object({
	providerId: z.string(),
	modelId: z.string(),
	enabled: z.boolean(),
});
const price = z.number().nonnegative();
export const modelPriceInput = z.object({
	providerId: z.string(),
	modelId: z.string(),
	// dollars per million tokens; null goes back to the Catalog's
	cost: z
		.object({
			input: price,
			output: price,
			cacheRead: price,
			cacheWrite: price,
		})
		.nullable(),
});

/** Providers, enabled Models and prices as saved in /console, with API keys decrypted. */
async function loadModelSettings(db: Db): Promise<ModelSettings> {
	const key = encryptionKey();
	const [providers, enabled, prices] = await Promise.all([
		db.select().from(provider),
		db.select().from(enabledModel),
		db.select().from(modelPrice),
	]);
	return {
		providers: providers.map((p) => ({
			id: p.id,
			apiKey: decryptSecret(p.apiKey, key),
			baseUrl: p.baseUrl,
		})),
		enabledModels: enabled.map((m) =>
			modelRef({ provider: m.providerId, id: m.modelId }),
		),
		modelPrices: pricesByModel(prices),
	};
}

const catalogProvider = async (id: string) =>
	(await catalogProviders()).find((p) => p.id === id);
const notInCatalog = (id: string): never => {
	throw new Error(`"${id}" is not a Provider in the Catalog`);
};

/**
 * The Models Runs use: `current()`, and `providers` for what Admins edit in /console/providers.
 * Loaded on the first `current()`, which rejects when that fails (also on a missing ORQESTRA_ENCRYPTION_KEY);
 * every write reloads it here and in every other process once committed. Callers check that the User is an Admin.
 */
export function createModels(db: Db) {
	const models = live(db, {
		channel: MODELS_CHANNEL,
		load: () => loadModelSettings(db).then(resolveModels),
	});
	const { write } = models;
	const providers = {
		/** The Catalog, and the Providers configured from it with their enabled Models. */
		async list() {
			const [catalog, rows, enabled, prices] = await Promise.all([
				catalogProviders(),
				db.select().from(provider).orderBy(provider.createdAt),
				db.select().from(enabledModel),
				db.select().from(modelPrice).then(pricesByModel),
			]);
			return {
				catalog: catalog.map((p) => ({
					id: p.id,
					name: p.name,
					baseUrl: p.baseUrl,
					models: p.models.map((m) => ({ id: m.id, name: m.name })),
				})),
				configured: rows.map((r) => ({
					id: r.id,
					baseUrl: r.baseUrl,
					keyReadable: secretReadable(r.apiKey),
					// each with the price in force: the Admin's, else the Catalog's (none when the Catalog dropped the Model)
					enabledModels: enabled
						.filter((e) => e.providerId === r.id)
						.map((e) => ({
							id: e.modelId,
							...priceInForce(
								prices,
								modelRef({ provider: r.id, id: e.modelId }),
								catalog
									.find((p) => p.id === r.id)
									?.models.find((m) => m.id === e.modelId)?.cost,
							),
						})),
				})),
			};
		},

		/** A blank key keeps the stored one; the Catalog's baseUrl is stored as null, so it follows the Catalog. */
		async save(
			input: z.infer<typeof providerInput>,
		): Promise<{ errors: Errors }> {
			const catalog = await catalogProvider(input.id);
			if (!catalog) return { errors: { id: { code: "not_in_catalog" } } };
			const baseUrl =
				input.baseUrl.replace(/\/+$/, "") ===
				catalog.baseUrl.replace(/\/+$/, "")
					? null
					: input.baseUrl;
			const [stored] = await db
				.select({ apiKey: provider.apiKey })
				.from(provider)
				.where(eq(provider.id, input.id));
			const apiKey = sealSecret(input.apiKey, stored?.apiKey);
			if (!apiKey) return { errors: { apiKey: { code: "api_key_required" } } };
			await write((tx) =>
				tx
					.insert(provider)
					.values({ id: input.id, apiKey, baseUrl })
					.onConflictDoUpdate({
						target: provider.id,
						set: { apiKey, baseUrl },
					}),
			);
			return { errors: {} };
		},

		/** Also deletes its key and enabled Models; Runs already using it finish. */
		delete: (id: string) =>
			write((tx) => tx.delete(provider).where(eq(provider.id, id))),

		/** Tries unsaved values on one Model; null when it worked, else the error. */
		async test(input: z.infer<typeof providerTestInput>) {
			const catalog =
				(await catalogProvider(input.id)) ?? notInCatalog(input.id);
			const model = catalog.models.find((m) => m.id === input.modelId);
			if (!model) throw new Error(`"${input.modelId}" is not in the Catalog`);
			const stored = await db.query.provider.findFirst({
				where: eq(provider.id, input.id),
			});
			const apiKey =
				input.apiKey || (stored && decryptSecret(stored.apiKey)) || undefined;
			if (!apiKey) return "An API key is required";
			return (await testConnection(model, apiKey, input.baseUrl)) ?? null;
		},

		async setModelEnabled(input: z.infer<typeof modelEnabledInput>) {
			if (input.enabled) {
				const catalog =
					(await catalogProvider(input.providerId)) ??
					notInCatalog(input.providerId);
				if (!catalog.models.some((m) => m.id === input.modelId))
					throw new Error(`"${input.modelId}" is not in the Catalog`);
			}
			await write((tx) =>
				input.enabled
					? tx
							.insert(enabledModel)
							.values({ providerId: input.providerId, modelId: input.modelId })
							.onConflictDoNothing()
					: tx
							.delete(enabledModel)
							.where(
								and(
									eq(enabledModel.providerId, input.providerId),
									eq(enabledModel.modelId, input.modelId),
								),
							),
			);
		},

		/** Sets an enabled Model's price, or clears it with a null `cost`; Runs that start afterwards are costed at it. */
		async setModelPrice({
			providerId,
			modelId,
			cost,
		}: z.infer<typeof modelPriceInput>): Promise<{ errors: Errors }> {
			const key = and(
				eq(enabledModel.providerId, providerId),
				eq(enabledModel.modelId, modelId),
			);
			const [enabled] = await db.select().from(enabledModel).where(key);
			if (!enabled)
				return { errors: { modelId: { code: "model_not_enabled" } } };
			await write((tx) =>
				cost
					? tx
							.insert(modelPrice)
							.values({ providerId, modelId, ...cost })
							.onConflictDoUpdate({
								target: [modelPrice.providerId, modelPrice.modelId],
								set: cost,
							})
					: tx
							.delete(modelPrice)
							.where(
								and(
									eq(modelPrice.providerId, providerId),
									eq(modelPrice.modelId, modelId),
								),
							),
			);
			return { errors: {} };
		},
	};
	return { ...models, providers };
}

export type ModelsLive = ReturnType<typeof createModels>;
