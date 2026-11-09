import { config, skillFiles } from "@orqestra/config/live";
import { createConversations } from "@orqestra/conversations";
import { z } from "zod";
import { createApp } from "./app.ts";
import { polaris } from "./polaris.ts";

// Validated at startup rather than on the first request
const env = z
	.object({
		ORQESTRA_URL: z.url(),
		POLARIS_ISSUER: z.url(),
		POLARIS_CLIENT_ID: z.string().min(1),
		POLARIS_CLIENT_SECRET: z.string().min(1),
		POLARIS_AUDIENCE: z.string().min(1),
		// Encrypts the session cookie; changing it signs everyone out. `openssl rand -base64 32`
		POLARIS_SECRET: z.string().min(32),
		// Encrypts Provider API keys in the database; `openssl rand -base64 32`
		ORQESTRA_ENCRYPTION_KEY: z.base64().refine((s) => atob(s).length === 32, {
			message: "must be 32 bytes of base64 (openssl rand -base64 32)",
		}),
	})
	.safeParse(process.env);
if (!env.success) {
	console.error(z.prettifyError(env.error));
	process.exit(1);
}

// a misconfigured instance does not come up
await config.current().catch((error) => {
	console.error(error.message);
	process.exit(1);
});

createApp({
	...polaris(env.data),
	conversations: createConversations({ config: config.current, skillFiles }),
}).listen(3001);
console.log("api listening on 3001");
