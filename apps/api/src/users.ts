import {
	listUsers,
	rememberUser,
	setSpendingLimit,
} from "@orqestra/conversations";
import { userSpendingLimit } from "@orqestra/conversations/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { adminOnly } from "./admin.ts";
import type { Session, SignedIn } from "./app.ts";

/** session, also remembering whoever it reads (ADR 0008); see rememberUser. */
export const rememberUsers =
	(session: Session): Session =>
	async (request) => {
		const read = await session(request);
		if (read.user) await rememberUser(read.user);
		return read;
	};

const notFound = { errors: { user: { code: "not_found" as const } } };

// The Users who have used Orqestra, for the console's Users page, with what they spent this month and their own Spending Limit
export const users = (signedIn: SignedIn) =>
	new Elysia({ prefix: "/users" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", async () => ({ users: await listUsers() }))
		/** A User's own Spending Limit, or `default` to follow the Limits' default; applies from their next request. */
		.put(
			"/:id/spending-limit",
			async ({ params, body, status }) =>
				(await setSpendingLimit(params.id, body))
					? { errors: {} }
					: status(404, notFound),
			{ params: z.object({ id: z.string() }), body: userSpendingLimit },
		);
