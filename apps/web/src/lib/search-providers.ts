import { searchProviderId, searchProviders, toolName } from "@orqestra/config";
import { decryptSecret, encryptSecret } from "@orqestra/config/secret";
import { db, eq } from "@orqestra/db";
import { instanceSettings, searchProvider } from "@orqestra/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { config, reloadConfig } from "#/lib/config";
import { requireAdmin } from "#/lib/session";

// Search Providers and which one serves each Tool, edited by Admins in /console/providers. API keys only go in.

export const getSearchProviders = createServerFn().handler(async () => {
	await requireAdmin();
	const [rows, [settings], loaded] = await Promise.all([
		db.select().from(searchProvider).orderBy(searchProvider.createdAt),
		db.select().from(instanceSettings),
		config.get(),
	]);
	return {
		configured: rows.map((r) => ({
			id: r.id,
			keyReadable: decryptSecret(r.apiKey) !== undefined,
			baseUrl: r.baseUrl,
		})),
		servedBy: {
			search: settings?.searchServedBy ?? null,
			scrape: settings?.scrapeServedBy ?? null,
		},
		/** Tools with a usable Search Provider. */
		available: toolName.options.filter((t) => loaded.tools[t]),
	};
});

export const saveSearchProvider = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: searchProviderId,
			// blank keeps the stored key
			apiKey: z.string().trim().optional(),
			// the official one, or a self-hosted service or reverse proxy
			baseUrl: z.url({ protocol: /^https?$/ }),
		}),
	)
	.handler(async ({ data }) => {
		await requireAdmin();
		const official = searchProviders.find((p) => p.id === data.id)?.baseUrl;
		// null keeps following the official one
		const baseUrl =
			data.baseUrl.replace(/\/+$/, "") === official ? null : data.baseUrl;
		const apiKey = data.apiKey ? encryptSecret(data.apiKey) : undefined;
		const stored = await db.query.searchProvider.findFirst({
			where: eq(searchProvider.id, data.id),
		});
		if (stored)
			await db
				.update(searchProvider)
				.set({ baseUrl, ...(apiKey && { apiKey }) })
				.where(eq(searchProvider.id, data.id));
		else {
			if (!apiKey) throw new Error("An API key is required");
			await db.insert(searchProvider).values({ id: data.id, apiKey, baseUrl });
		}
		await reloadConfig();
	});

/** Tools it served become unavailable until another is picked. */
export const deleteSearchProvider = createServerFn({ method: "POST" })
	.validator(searchProviderId)
	.handler(async ({ data }) => {
		await requireAdmin();
		await db.delete(searchProvider).where(eq(searchProvider.id, data));
		await reloadConfig();
	});

export const setServedBy = createServerFn({ method: "POST" })
	.validator(
		z.object({ tool: toolName, provider: searchProviderId.nullable() }),
	)
	.handler(async ({ data }) => {
		await requireAdmin();
		const set =
			data.tool === "search"
				? { searchServedBy: data.provider }
				: { scrapeServedBy: data.provider };
		await db
			.insert(instanceSettings)
			.values(set)
			.onConflictDoUpdate({ target: instanceSettings.id, set });
		await reloadConfig();
	});
