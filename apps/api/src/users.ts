import { config } from "@orqestra/config/live";
import { userSpendingLimit } from "@orqestra/config/shared";
import { spendingMonth } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { usage, user } from "@orqestra/db/schema";
import { desc, eq, getTableColumns, gte, sql, sum } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import { adminOnly } from "./admin.ts";
import type { Session, SignedIn } from "./app.ts";

/**
 * session, also remembering whoever it reads (ADR 0008): their name and email, written only when they
 * change, and their last-active time, moved at most hourly. Never whether they are an Admin.
 */
export const rememberUsers =
	(session: Session): Session =>
	async (request) => {
		const read = await session(request);
		if (!read.user) return read;
		const { id, name, email } = read.user;
		const stale = sql`${user.lastActiveAt} < excluded.last_active_at - interval '1 hour'`;
		await db
			.insert(user)
			.values({ id, name, email: email ?? null, lastActiveAt: new Date() })
			.onConflictDoUpdate({
				target: user.id,
				set: {
					name: sql`excluded.name`,
					email: sql`excluded.email`,
					lastActiveAt: sql`case when ${stale} then excluded.last_active_at else ${user.lastActiveAt} end`,
				},
				setWhere: sql`${user.name} is distinct from excluded.name or ${user.email} is distinct from excluded.email or ${stale}`,
			});
		return read;
	};

const notFound = { errors: { user: { code: "not_found" as const } } };

// The Users who have used Orqestra, for the console's Users page, with what they spent this month and their own Spending Limit
export const users = (signedIn: SignedIn) =>
	new Elysia({ prefix: "/users" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", async () => {
			const { resetTimeZone } = await config.limits.get();
			const { start } = spendingMonth(resetTimeZone, new Date());
			const month = db
				.select({ userId: usage.userId, spent: sum(usage.cost).as("spent") })
				.from(usage)
				.where(gte(usage.createdAt, start))
				.groupBy(usage.userId)
				.as("month");
			return {
				users: await db
					.select({
						...getTableColumns(user),
						spent: sql`coalesce(${month.spent}, 0)`.mapWith(Number),
					})
					.from(user)
					.leftJoin(month, eq(month.userId, user.id))
					.orderBy(desc(user.lastActiveAt)),
			};
		})
		/** A User's own Spending Limit, or `default` to follow the Limits' default; applies from their next request. */
		.put(
			"/:id/spending-limit",
			async ({ params, body, status }) => {
				const [set] = await db
					.update(user)
					.set({ spendingLimit: body })
					.where(eq(user.id, params.id))
					.returning({ id: user.id });
				return set ? { errors: {} } : status(404, notFound);
			},
			{ params: z.object({ id: z.string() }), body: userSpendingLimit },
		);
