import { type Config, limitsInput } from "@orqestra/config/live";
import { Elysia } from "elysia";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// The Limits, edited by Admins in /console/limits; the next Run reads them
export const limits = (signedIn: SignedIn, config: Config) =>
	new Elysia({ prefix: "/limits" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", async () => ({ limits: await config.limits.get() }))
		.put("/", async ({ body }) => saved(await config.limits.save(body)), {
			body: limitsInput,
		});
