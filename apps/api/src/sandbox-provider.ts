import type { Capabilities } from "@orqestra/conversations";
import { sandboxProviderInput } from "@orqestra/tools/live";
import { Elysia } from "elysia";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// The Sandbox Provider (orrery), edited by Admins in /console/sandbox. The API Token only goes in.
export const sandboxProvider = (signedIn: SignedIn, config: Capabilities) =>
	new Elysia({ prefix: "/sandbox-provider" })
		.use(signedIn)
		.derive(adminOnly)
		// wrapped, as a bare null would be an empty body
		.get("/", async () => ({
			provider: await config.tools.sandboxProvider.get(),
		}))
		// once saved, with the connection test's result
		.post(
			"/",
			async ({ body }) => saved(await config.tools.sandboxProvider.save(body)),
			{ body: sandboxProviderInput },
		)
		// Every Skill becomes unavailable
		.delete("/", async () => {
			await config.tools.sandboxProvider.delete();
		});
