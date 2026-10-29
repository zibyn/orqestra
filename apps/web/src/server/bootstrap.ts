import { config } from "@orqestra/config/live";
import { definePlugin } from "nitro";
import { env } from "#/env";
import { setupInstance } from "#/lib/auth";
import { bootstrapDefaultAdmin } from "#/lib/identity";

// Env-var Instance Setup at server startup; a failure is left unhandled so a misconfigured server does not come up
export default definePlugin(() => {
	void bootstrapDefaultAdmin(env, setupInstance);
	config.current().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
});
