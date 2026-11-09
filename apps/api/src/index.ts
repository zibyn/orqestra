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
	})
	.safeParse(process.env);
if (!env.success) {
	console.error(z.prettifyError(env.error));
	process.exit(1);
}

createApp(polaris(env.data)).listen(3001);
console.log("api listening on 3001");
