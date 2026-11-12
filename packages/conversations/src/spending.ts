import { db } from "@orqestra/db";
import { limits, usage, user } from "@orqestra/db/schema";
import { CronExpressionParser } from "cron-parser";
import { and, eq, gte, sum } from "drizzle-orm";
import { DEFAULT_LIMITS } from "./limits.ts";

export const SPENDING_LIMIT_USED_UP = "This month's Spending Limit is used up";

/** A Model request was not sent: its User has used up this month's Spending Limit. */
export class SpendingLimitReached extends Error {
	override name = "SpendingLimitReached";
	constructor() {
		super(SPENDING_LIMIT_USED_UP);
	}
}

/** What each User spent from `start` on, or only `userId` when given; summed over the (user_id, created_at) index. */
export const spentSince = (start: Date, userId?: string) =>
	db
		.select({
			userId: usage.userId,
			spent: sum(usage.cost).mapWith(Number).as("spent"),
		})
		.from(usage)
		.where(
			and(
				userId === undefined ? undefined : eq(usage.userId, userId),
				gte(usage.createdAt, start),
			),
		)
		.groupBy(usage.userId);

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
	const [[row], [own]] = await Promise.all([
		db
			.select({
				spendingLimit: limits.spendingLimit,
				resetTimeZone: limits.resetTimeZone,
			})
			.from(limits),
		db
			.select({ spendingLimit: user.spendingLimit })
			.from(user)
			.where(eq(user.id, userId)),
	]);
	const defaults = row ?? DEFAULT_LIMITS;
	const { resetTimeZone } = defaults;
	// the User's own setting, unless it follows the default (as one without a local record does)
	const spendingLimit =
		!own || own.spendingLimit.mode === "default"
			? defaults.spendingLimit
			: own.spendingLimit;
	if (spendingLimit.mode === "unlimited") return null;
	const { start, resetsAt } = spendingMonth(resetTimeZone, now);
	// summed on each request; concurrent requests may overshoot, unlocked
	const [mine] = await spentSince(start, userId);
	const used = mine?.spent ?? 0;
	return {
		spent: used,
		usd: spendingLimit.usd,
		// so $0 is used up from the start
		reached: used >= spendingLimit.usd,
		resetsAt,
		// to show the reset date as it falls there, not in the browser's zone
		resetTimeZone,
	};
}
