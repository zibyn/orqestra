import { createConfig, skillFiles } from "@orqestra/config/live";
import { createConversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { connectionStore } from "@orqestra/mcp";
import { s3Store } from "@orqestra/tools/s3";
import { z } from "zod";
import { createApp } from "./app.ts";
import { polaris } from "./polaris.ts";
import { rememberUsers } from "./users.ts";

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
		// Web Push Alerts, all three or none; `npx web-push generate-vapid-keys`
		VAPID_PUBLIC_KEY: z.string().min(1).optional(),
		VAPID_PRIVATE_KEY: z.string().min(1).optional(),
		VAPID_SUBJECT: z
			.string()
			.regex(/^(mailto:|https:\/\/)/, "must be a mailto: or https:// URL")
			.optional(),
	})
	.refine(
		(e) =>
			new Set(
				[e.VAPID_PUBLIC_KEY, e.VAPID_PRIVATE_KEY, e.VAPID_SUBJECT].map(
					(v) => !v,
				),
			).size === 1,
		{
			message:
				"set all of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT, or none",
		},
	)
	.safeParse(process.env);
if (!env.success) {
	console.error(z.prettifyError(env.error));
	process.exit(1);
}

let store: ReturnType<typeof s3Store>;
try {
	store = s3Store();
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}

const config = createConfig(db);
// a misconfigured instance does not come up
await config.current().catch((error) => {
	console.error(error.message);
	process.exit(1);
});

const { session, auth } = polaris(env.data);
createApp({
	session: rememberUsers(session),
	auth,
	orqestraUrl: env.data.ORQESTRA_URL,
	config,
	conversations: createConversations({
		config: config.current,
		skillFiles,
		store,
		connections: connectionStore,
		mcpServers: config,
		agents: config.agents,
	}),
}).listen(3001);
console.log("api listening on 3001");
