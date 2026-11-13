import type { Db } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import { limits } from "@orqestra/db/schema";
import { z } from "zod";
import { type SpendingLimit, spendingLimit, timeZone } from "./shared.ts";

/** NOTIFY channel, no payload: the Limits changed, reload them (web -> web and worker). */
const LIMITS_CHANNEL = "limits_changed";

/** The Limits an Admin sets in /console/limits; durations in seconds. */
export interface Limits {
	maxScheduledTasksPerUser: number;
	/** The shortest interval between two Firings of a recurring Scheduled Task. */
	minFiringInterval: number;
	timerRingsPerUserMessage: number;
	/** Model requests an Unattended Run may make; the last one, without Tools, is for its final answer. */
	unattendedMaxSteps: number;
	/** Wall-clock time an Unattended Run may take before it is aborted. */
	unattendedMaxDuration: number;
	/** 1 to 3. */
	maxSubagentDepth: number;
	/** The default Spending Limit, every User's unless they have their own. */
	spendingLimit: SpendingLimit;
	/** The IANA time zone whose calendar months Spending Limits cover. */
	resetTimeZone: string;
	/** How long a Background Call is tracked before it is cancelled and ends failed. */
	backgroundCallMaxDuration: number;
	/** Tokens kept free for the model's reply: a Run compacts once its context would leave fewer. */
	compactionReserveTokens: number;
	/** Tokens of the latest messages a compaction keeps as they are. */
	compactionKeepRecentTokens: number;
}

/** The Limits until an Admin saves them. */
export const DEFAULT_LIMITS: Limits = {
	maxScheduledTasksPerUser: 10,
	minFiringInterval: 60 * 60,
	timerRingsPerUserMessage: 10,
	unattendedMaxSteps: 50,
	unattendedMaxDuration: 30 * 60,
	maxSubagentDepth: 2,
	spendingLimit: { mode: "unlimited" },
	resetTimeZone: "UTC",
	backgroundCallMaxDuration: 24 * 60 * 60,
	// pi's DEFAULT_COMPACTION_SETTINGS
	compactionReserveTokens: 16384,
	compactionKeepRecentTokens: 20000,
};

const count = z.number().int().positive();
export const limitsInput = z.object({
	maxScheduledTasksPerUser: count,
	/** Seconds. */
	minFiringInterval: count,
	timerRingsPerUserMessage: count,
	unattendedMaxSteps: count,
	/** Seconds. */
	unattendedMaxDuration: count,
	maxSubagentDepth: z.number().int().min(1).max(3),
	/** Every User's, unless the User has their own. */
	spendingLimit,
	/** Where a calendar month of Spending Limits begins and ends. */
	resetTimeZone: timeZone,
	/** Seconds, from a minute to 30 days. */
	backgroundCallMaxDuration: z
		.number()
		.int()
		.min(60)
		.max(30 * 24 * 60 * 60),
	compactionReserveTokens: count,
	compactionKeepRecentTokens: count,
});

/**
 * The Limits: `current()` for Runs, and what Admins edit in /console/limits (one row, with a fixed id). Every save reloads them here
 * and in every other process once committed. Callers check that the User is an Admin.
 */
export function createLimits(db: Db) {
	const stored = live(db, {
		channel: LIMITS_CHANNEL,
		load: async (): Promise<Limits> => {
			const [saved] = await db.select().from(limits);
			// a stored row, read again by limitsInput so a bad one fails the load like a bad Agent Definition
			return saved ? limitsInput.parse(saved) : DEFAULT_LIMITS;
		},
	});
	return {
		...stored,
		/** As saved, or the defaults. */
		async get(): Promise<Limits> {
			const row = await db.query.limits.findFirst();
			if (!row) return DEFAULT_LIMITS;
			const { id: _, ...saved } = row;
			return saved;
		},
		/** The next Run reads them. */
		async save(
			input: z.infer<typeof limitsInput>,
		): Promise<{ errors: Record<string, never> }> {
			await stored.write((tx) =>
				tx
					.insert(limits)
					.values({ id: 1, ...input })
					.onConflictDoUpdate({ target: limits.id, set: input }),
			);
			return { errors: {} };
		},
	};
}

export type LimitsLive = ReturnType<typeof createLimits>;
