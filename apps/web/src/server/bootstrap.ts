import { config } from "@orqestra/config/live";
import { definePlugin } from "nitro";
// Validates the env vars at startup rather than on the first request
import "#/env";

// Checks the live config at server startup, so a misconfigured server does not come up
export default definePlugin(() => {
	config.current().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
});
