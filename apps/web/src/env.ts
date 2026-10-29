import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		SERVER_URL: z.string().url().optional(),
		// Comma-separated extra origins allowed to sign in besides BETTER_AUTH_URL, e.g. a LAN address
		BETTER_AUTH_TRUSTED_ORIGINS: z
			.string()
			.optional()
			.transform(
				(s) =>
					s
						?.split(",")
						.map((o) => o.trim())
						.filter(Boolean) ?? [],
			),
		// Encrypts Provider API keys in the database; `openssl rand -base64 32`
		ORQESTRA_ENCRYPTION_KEY: z.base64().refine((s) => atob(s).length === 32, {
			message: "must be 32 bytes of base64 (openssl rand -base64 32)",
		}),
		ADMIN_EMAIL: z.string().email().optional(),
		ADMIN_PASSWORD: z.string().min(8).optional(),
		OIDC_ISSUER: z.string().url().optional(),
		OIDC_CLIENT_ID: z.string().optional(),
		OIDC_CLIENT_SECRET: z.string().optional(),
	},

	/**
	 * The prefix that client-side variables must have. This is enforced both at
	 * a type-level and at runtime.
	 */
	clientPrefix: "VITE_",

	client: {
		VITE_APP_TITLE: z.string().min(1).optional(),
	},

	/**
	 * What object holds the environment variables at runtime. This is usually
	 * `process.env` or `import.meta.env`.
	 */
	// Server vars are only in process.env at runtime (Vite inlines just VITE_*)
	runtimeEnv: { ...import.meta.env, ...globalThis.process?.env },

	/**
	 * By default, this library will feed the environment variables directly to
	 * the Zod validator.
	 *
	 * This means that if you have an empty string for a value that is supposed
	 * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
	 * it as a type mismatch violation. Additionally, if you have an empty string
	 * for a value that is supposed to be a string with a default value (e.g.
	 * `DOMAIN=` in an ".env" file), the default value will never be applied.
	 *
	 * In order to solve these issues, we recommend that all new projects
	 * explicitly specify this option as true.
	 */
	emptyStringAsUndefined: true,
});
