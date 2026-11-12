import type { Capabilities } from "@orqestra/conversations";
import { searchProviderInput, toolServiceInput } from "@orqestra/tools/live";
import { searchProviderId } from "@orqestra/tools/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// Search Providers and which one serves each Tool, edited by Admins in /console/search. API keys only go in.
export const searchProviders = (signedIn: SignedIn, config: Capabilities) =>
	new Elysia({ prefix: "/search-providers" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", () => config.tools.searchProviders.list())
		.post(
			"/",
			async ({ body }) => saved(await config.tools.searchProviders.save(body)),
			{ body: searchProviderInput },
		)
		// Tools it served become unavailable until another is picked
		.delete(
			"/:id",
			async ({ params }) => {
				await config.tools.searchProviders.delete(params.id);
			},
			{ params: z.object({ id: searchProviderId }) },
		)
		.put(
			"/tools",
			async ({ body }) => {
				await config.tools.searchProviders.serve(body.tool, body.provider);
			},
			{ body: toolServiceInput },
		);
