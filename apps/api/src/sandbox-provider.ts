import { config, sandboxProviderInput } from "@orqestra/config/live";
import { Elysia } from "elysia";
import { saved } from "./saved.ts";

// The Sandbox Provider (orrery), edited by Admins in /console/sandbox. The API Token only goes in.
export const sandboxProvider = new Elysia({ prefix: "/sandbox-provider" })
	// wrapped, as a bare null would be an empty body
	.get("/", async () => ({ provider: await config.sandboxProvider.get() }))
	// once saved, with the connection test's result
	.post(
		"/",
		async ({ body }) => saved(await config.sandboxProvider.save(body)),
		{ body: sandboxProviderInput },
	)
	// Every Skill becomes unavailable
	.delete("/", async () => {
		await config.sandboxProvider.delete();
	});
