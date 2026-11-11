import { spendingLimitStatus, summarizeUsage } from "@orqestra/conversations";
import { Elysia } from "elysia";
import { z } from "zod";
import { adminOnly, signedInOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

/**
 * A Usage summary's query: the range [from, to), its ends worked out by the browser in its own time zone;
 * the dimension to group by; and filters to drill down: `agent` an Agent's id, or empty for the general
 * worker, `model` a Model's `provider/id`.
 */
export const usageQuery = z.object({
	from: instant,
	to: instant,
	group: z.enum(["agent", "model"]),
	agent: z.string().optional(),
	model: z.string().optional(),
});

/** An Admin's Usage query: also by User, and filterable by a User's id. */
export const adminUsageQuery = usageQuery.extend({
	group: z.enum(["user", "agent", "model"]),
	user: z.string().optional(),
});

/** /api/usage/mine: the signed-in User's own Usage, nobody else's, Admins included. /api/usage: everyone's, for Admins. */
export const usageRoutes = (signedIn: SignedIn) =>
	new Elysia({ prefix: "/usage" })
		.use(
			new Elysia()
				.use(signedIn)
				.derive(signedInOnly)
				.get(
					"/mine",
					async ({ user, query }) => ({
						rows: await summarizeUsage({ ...query, user: user.id }),
						// this month's, whatever the range; null without a limit
						status: await spendingLimitStatus(user.id),
					}),
					{ query: usageQuery },
				),
		)
		.use(
			new Elysia()
				.use(signedIn)
				.derive(adminOnly)
				.get(
					"/",
					async ({ query }) => ({ rows: await summarizeUsage(query) }),
					{
						query: adminUsageQuery,
					},
				),
		);
