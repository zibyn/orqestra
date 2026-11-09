import {
	config,
	modelEnabledInput,
	providerInput,
	providerTestInput,
} from "@orqestra/config/live";
import { Elysia } from "elysia";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// Providers and enabled Models, edited by Admins in /console/providers. API keys only go in, never back out.
export const providers = (signedIn: SignedIn) =>
	new Elysia({ prefix: "/providers" })
		.use(signedIn)
		.onBeforeHandle(adminOnly)
		.get("/", () => config.providers.list())
		.post("/", async ({ body }) => saved(await config.providers.save(body)), {
			body: providerInput,
		})
		// Tries the form's unsaved values on one Model
		.post(
			"/test",
			async ({ body }) => ({ error: await config.providers.test(body) }),
			{ body: providerTestInput },
		)
		// Also deletes its key and enabled Models; Runs already using it finish
		.delete("/:id", async ({ params }) => {
			await config.providers.delete(params.id);
		})
		.put(
			"/models",
			async ({ body }) => {
				await config.providers.setModelEnabled(body);
			},
			{ body: modelEnabledInput },
		);
