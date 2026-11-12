import { db } from "@orqestra/db";
import { limits, user } from "@orqestra/db/schema";
import { desc, eq, getTableColumns, sql } from "drizzle-orm";
import { DEFAULT_LIMITS } from "./limits.ts";
import type { UserSpendingLimit } from "./shared.ts";
import { spendingMonth, spentSince } from "./spending.ts";

/**
 * Remembers a signed-in User (ADR 0008): their name and email, written only when they change,
 * and their last-active time, moved at most hourly. Never whether they are an Admin.
 */
export async function rememberUser({
	id,
	name,
	email,
}: {
	id: string;
	name: string;
	email?: string;
}) {
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
}

/** The Users who have used Orqestra, most recently active first, with what they spent this month. */
export async function listUsers(now = new Date()) {
	const [row] = await db
		.select({ resetTimeZone: limits.resetTimeZone })
		.from(limits);
	const { start } = spendingMonth((row ?? DEFAULT_LIMITS).resetTimeZone, now);
	const month = spentSince(start).as("month");
	return db
		.select({
			...getTableColumns(user),
			spent: sql`coalesce(${month.spent}, 0)`.mapWith(Number),
		})
		.from(user)
		.leftJoin(month, eq(month.userId, user.id))
		.orderBy(desc(user.lastActiveAt));
}

/** Sets a User's own Spending Limit, or `default` to follow the Limits' default, from their next request; false when Orqestra has no such User. */
export async function setSpendingLimit(
	id: string,
	spendingLimit: UserSpendingLimit,
) {
	const [set] = await db
		.update(user)
		.set({ spendingLimit })
		.where(eq(user.id, id))
		.returning({ id: user.id });
	return !!set;
}
