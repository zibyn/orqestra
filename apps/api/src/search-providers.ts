import { searchProviderId } from "@orqestra/config";
import {
	config,
	searchProviderInput,
	toolServiceInput,
} from "@orqestra/config/live";
import { Elysia } from "elysia";
import { z } from "zod";
import { saved } from "./saved.ts";

// Search Providers and which one serves each Tool, edited by Admins in /console/search. API keys only go in.
export const searchProviders = new Elysia({ prefix: "/search-providers" })
	.get("/", () => config.searchProviders.list())
	.post(
		"/",
		async ({ body }) => saved(await config.searchProviders.save(body)),
		{ body: searchProviderInput },
	)
	// Tools it served become unavailable until another is picked
	.delete(
		"/:id",
		async ({ params }) => {
			await config.searchProviders.delete(params.id);
		},
		{ params: z.object({ id: searchProviderId }) },
	)
	.put(
		"/tools",
		async ({ body }) => {
			await config.searchProviders.serve(body.tool, body.provider);
		},
		{ body: toolServiceInput },
	);
