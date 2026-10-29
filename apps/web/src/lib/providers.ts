import { catalogProviders, testConnection } from "@orqestra/config";
import { decryptSecret, encryptSecret } from "@orqestra/config/secret";
import { and, db, eq } from "@orqestra/db";
import { enabledModel, provider } from "@orqestra/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { reloadConfig as reload } from "#/lib/config";
import { requireAdmin } from "#/lib/session";

// Providers and enabled Models, edited by Admins in /console/providers. API keys only go in, never back out.

async function catalogProvider(id: string) {
	const found = (await catalogProviders()).find((p) => p.id === id);
	if (!found) throw new Error(`"${id}" is not a Provider in the Catalog`);
	return found;
}

const storedProvider = (id: string) =>
	db.query.provider.findFirst({ where: eq(provider.id, id) });

const form = z.object({
	id: z.string().min(1),
	// blank keeps the stored key
	apiKey: z.string().trim().optional(),
	// blank means the Catalog's baseUrl
	baseUrl: z.union([z.url({ protocol: /^https?$/ }), z.literal("")]).optional(),
});

export const getProviders = createServerFn().handler(async () => {
	await requireAdmin();
	const [catalog, rows, enabled] = await Promise.all([
		catalogProviders(),
		db.select().from(provider).orderBy(provider.createdAt),
		db.select().from(enabledModel),
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
			// false after ORQESTRA_ENCRYPTION_KEY changed: the Admin must enter the key again
			keyReadable: decryptSecret(r.apiKey) !== undefined,
			enabledModels: enabled
				.filter((e) => e.providerId === r.id)
				.map((e) => e.modelId),
		})),
	};
});

export const saveProvider = createServerFn({ method: "POST" })
	.validator(form)
	.handler(async ({ data }) => {
		await requireAdmin();
		await catalogProvider(data.id);
		const baseUrl = data.baseUrl || null;
		const apiKey = data.apiKey ? encryptSecret(data.apiKey) : undefined;
		if (await storedProvider(data.id))
			await db
				.update(provider)
				.set({ baseUrl, ...(apiKey && { apiKey }) })
				.where(eq(provider.id, data.id));
		else {
			if (!apiKey) throw new Error("An API key is required");
			await db.insert(provider).values({ id: data.id, apiKey, baseUrl });
		}
		await reload();
	});

/** Also deletes its key and enabled Models; Runs already using it finish. */
export const deleteProvider = createServerFn({ method: "POST" })
	.validator(z.string())
	.handler(async ({ data }) => {
		await requireAdmin();
		await db.delete(provider).where(eq(provider.id, data));
		await reload();
	});

export const setModelEnabled = createServerFn({ method: "POST" })
	.validator(
		z.object({
			providerId: z.string(),
			modelId: z.string(),
			enabled: z.boolean(),
		}),
	)
	.handler(async ({ data }) => {
		await requireAdmin();
		if (data.enabled) {
			const catalog = await catalogProvider(data.providerId);
			if (!catalog.models.some((m) => m.id === data.modelId))
				throw new Error(`"${data.modelId}" is not in the Catalog`);
			await db
				.insert(enabledModel)
				.values({ providerId: data.providerId, modelId: data.modelId })
				.onConflictDoNothing();
		} else
			await db
				.delete(enabledModel)
				.where(
					and(
						eq(enabledModel.providerId, data.providerId),
						eq(enabledModel.modelId, data.modelId),
					),
				);
		await reload();
	});

/** Tries the form's unsaved values on one Model; null when it worked, else the error. */
export const testProvider = createServerFn({ method: "POST" })
	.validator(form.extend({ modelId: z.string() }))
	.handler(async ({ data }) => {
		await requireAdmin();
		const model = (await catalogProvider(data.id)).models.find(
			(m) => m.id === data.modelId,
		);
		if (!model) throw new Error(`"${data.modelId}" is not in the Catalog`);
		const stored = await storedProvider(data.id);
		const apiKey =
			data.apiKey || (stored && decryptSecret(stored.apiKey)) || undefined;
		if (!apiKey) return "An API key is required";
		return (await testConnection(model, apiKey, data.baseUrl)) ?? null;
	});
