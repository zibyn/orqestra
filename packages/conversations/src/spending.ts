import { DEFAULT_LIMITS } from "@orqestra/config";
import { db } from "@orqestra/db";
import { limits, usage } from "@orqestra/db/schema";
import { CronExpressionParser } from "cron-parser";
import { and, eq, gte, sum } from "drizzle-orm";

/** A Model request was not sent: its User has used up this month's Spending Limit. */
export class SpendingLimitReached extends Error {
	override name = "SpendingLimitReached";
	constructor() {
		super("This month's Spending Limit is used up");
	}
}

/** The calendar month `now` falls in, in `timeZone`: from the 1st at midnight to the next 1st, when the limit resets. */
export function spendingMonth(timeZone: string, now: Date) {
	const firsts = (currentDate: Date) =>
		CronExpressionParser.parse("0 0 1 * *", { currentDate, tz: timeZone });
	return {
		// a millisecond on, so midnight on the 1st itself starts the month
		start: firsts(new Date(now.getTime() + 1))
			.prev()
			.toDate(),
		resetsAt: firsts(now).next().toDate(),
	};
}

/**
 * The User's Spending Limit this month, read afresh so a change applies from the next request: what they spent,
 * the limit, whether it is used up and when it resets. Null when they have none.
 */
export async function spendingLimitStatus(userId: string, now = new Date()) {
	const [row] = await db
		.select({
			spendingLimit: limits.spendingLimit,
			resetTimeZone: limits.resetTimeZone,
		})
		.from(limits);
	// shortcut: the default limit for everyone; #109 lets a User's own setting replace it
	const { spendingLimit, resetTimeZone } = row ?? DEFAULT_LIMITS;
	if (spendingLimit.mode === "unlimited") return null;
	const { start, resetsAt } = spendingMonth(resetTimeZone, now);
	// summed on each request over the (user_id, created_at) index; concurrent requests may overshoot, unlocked
	const [{ spent }] = await db
		.select({ spent: sum(usage.cost).mapWith(Number) })
		.from(usage)
		.where(and(eq(usage.userId, userId), gte(usage.createdAt, start)));
	const used = spent ?? 0;
	return {
		spent: used,
		usd: spendingLimit.usd,
		// so $0 is used up from the start
		reached: used >= spendingLimit.usd,
		resetsAt,
	};
}
