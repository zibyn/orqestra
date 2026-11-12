import type { Capabilities } from "@orqestra/conversations";
import {
	modelEnabledInput,
	modelPriceInput,
	providerInput,
	providerTestInput,
} from "@orqestra/models";
import { Elysia } from "elysia";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// Providers and enabled Models, edited by Admins in /console/providers. API keys only go in, never back out.
export const providers = (signedIn: SignedIn, config: Capabilities) =>
	new Elysia({ prefix: "/providers" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", () => config.models.providers.list())
		.post(
			"/",
			async ({ body }) => saved(await config.models.providers.save(body)),
			{
				body: providerInput,
			},
		)
		// Tries the form's unsaved values on one Model
		.post(
			"/test",
			async ({ body }) => ({ error: await config.models.providers.test(body) }),
			{ body: providerTestInput },
		)
		// Also deletes its key and enabled Models; Runs already using it finish
		.delete("/:id", async ({ params }) => {
			await config.models.providers.delete(params.id);
		})
		.put(
			"/models",
			async ({ body }) => {
				await config.models.providers.setModelEnabled(body);
			},
			{ body: modelEnabledInput },
		)
		// Only for an enabled Model; a null cost goes back to the Catalog's price
		.put(
			"/models/price",
			async ({ body }) =>
				saved(await config.models.providers.setModelPrice(body)),
			{ body: modelPriceInput },
		);
