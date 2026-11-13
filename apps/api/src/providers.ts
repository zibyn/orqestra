import type { ModelsLive } from "@orqestra/models";
import {
	defaultModelInput,
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
export const providers = (
	signedIn: SignedIn,
	models: Pick<ModelsLive, "providers">,
) =>
	new Elysia({ prefix: "/providers" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", () => models.providers.list())
		.post("/", async ({ body }) => saved(await models.providers.save(body)), {
			body: providerInput,
		})
		// Tries the form's unsaved values on one Model
		.post(
			"/test",
			async ({ body }) => ({ error: await models.providers.test(body) }),
			{ body: providerTestInput },
		)
		// Also deletes its key and enabled Models; Runs already using it finish
		.delete("/:id", async ({ params }) => {
			await models.providers.delete(params.id);
		})
		.put(
			"/models",
			async ({ body }) => {
				await models.providers.setModelEnabled(body);
			},
			{ body: modelEnabledInput },
		)
		// Only for an enabled Model; a null cost goes back to the Catalog's price
		.put(
			"/models/price",
			async ({ body }) => saved(await models.providers.setModelPrice(body)),
			{ body: modelPriceInput },
		)
		// Only for an enabled Model; it takes over from the one marked before
		.put(
			"/models/default",
			async ({ body }) => saved(await models.providers.setDefaultModel(body)),
			{ body: defaultModelInput },
		);
