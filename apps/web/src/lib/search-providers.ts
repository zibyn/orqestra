import { searchProviderId } from "@orqestra/config";
import {
	config,
	searchProviderInput,
	toolServiceInput,
} from "@orqestra/config/live";
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "#/lib/session";

// Search Providers and which one serves each Tool, edited by Admins in /console/providers. API keys only go in.

export const getSearchProviders = createServerFn().handler(async () => {
	await requireAdmin();
	return config.searchProviders.list();
});

/** Field errors by name (`apiKey`); empty when it was saved. */
export const saveSearchProvider = createServerFn({ method: "POST" })
	.validator(searchProviderInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		return config.searchProviders.save(data);
	});

/** Tools it served become unavailable until another is picked. */
export const deleteSearchProvider = createServerFn({ method: "POST" })
	.validator(searchProviderId)
	.handler(async ({ data }) => {
		await requireAdmin();
		await config.searchProviders.delete(data);
	});

export const setServedBy = createServerFn({ method: "POST" })
	.validator(toolServiceInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		await config.searchProviders.serve(data.tool, data.provider);
	});
