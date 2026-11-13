import { type createLimits, limitsInput } from "@orqestra/conversations";
import { Elysia } from "elysia";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// The Limits, edited by Admins in /console/limits; the next Run reads them
export const limits = (
	signedIn: SignedIn,
	limits: ReturnType<typeof createLimits>,
) =>
	new Elysia({ prefix: "/limits" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", async () => ({ limits: await limits.get() }))
		.put("/", async ({ body }) => saved(await limits.save(body)), {
			body: limitsInput,
		});
