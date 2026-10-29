import { searchProviderId, toolName } from "@orqestra/config";
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
		z.object({ id: searchProviderId, apiKey: z.string().trim().min(1) }),
	)
	.handler(async ({ data }) => {
		await requireAdmin();
		const apiKey = encryptSecret(data.apiKey);
		await db
			.insert(searchProvider)
			.values({ id: data.id, apiKey })
			.onConflictDoUpdate({ target: searchProvider.id, set: { apiKey } });
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
