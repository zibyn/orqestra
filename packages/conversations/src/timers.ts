import { db } from "@orqestra/db";
import { conversation, message, timer } from "@orqestra/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { ensureRun, lockRoot, queueInput, runQueue, saved } from "./runs.ts";

// A Timer is its `timer` row: cancelling deletes the row, and a job that finds it gone or replaced does nothing.

/** BullMQ queue of delayed jobs `{ conversationId, ringsAt }`, one per Timer set. */
export const TIMERS_QUEUE = "timers";
/** The shortest and longest delay a Timer may ring after, in seconds. */
export const MIN_TIMER_DELAY = 60;
export const MAX_TIMER_DELAY = 24 * 60 * 60;

/** A delay outside MIN_TIMER_DELAY to MAX_TIMER_DELAY. */
export class TimerDelayOutOfRange extends Error {
	override name = "TimerDelayOutOfRange";
	constructor(readonly delay: number) {
		super(
			`A timer's delay is ${MIN_TIMER_DELAY} to ${MAX_TIMER_DELAY} seconds, not ${delay}`,
		);
	}
}
/** Timers rang `max` times since the User's last message: no more may be set until they write. */
export class TimerLimitReached extends Error {
	override name = "TimerLimitReached";
	constructor(readonly max: number) {
		super(`The timer rang ${max} times since the user's last message`);
	}
}

/**
 * Sets the Conversation's Timer, replacing the one it had, to ring `delay` seconds from now with `note`,
 * delivered on `model` and `thinkingLevel`; returns when it rings.
 */
export async function setTimer(
	conversationId: string,
	{
		delay,
		note,
		model,
		thinkingLevel,
		maxRings,
	}: {
		delay: number;
		note: string;
		model: string;
		thinkingLevel: string;
		/** The Limits' timer_rings_per_user_message. */
		maxRings: number;
	},
) {
	if (
		!Number.isFinite(delay) ||
		delay < MIN_TIMER_DELAY ||
		delay > MAX_TIMER_DELAY
	)
		throw new TimerDelayOutOfRange(delay);
	const ringsAt = new Date(Date.now() + delay * 1000);
	await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		const conv = await tx.query.conversation.findFirst({
			where: eq(conversation.id, conversationId),
		});
		if ((conv?.timerRingsSinceUser ?? 0) >= maxRings)
			throw new TimerLimitReached(maxRings);
		const row = {
			note,
			ringsAt,
			// the Tool call's message, saved before the Tool runs, or a later one of its Turn
			messageId: sql`(select max(${message.id}) from ${message} where ${message.conversationId} = ${conversationId})`,
			model,
			thinkingLevel,
		};
		await tx
			.insert(timer)
			.values({ conversationId, ...row })
			.onConflictDoUpdate({ target: timer.conversationId, set: row });
	});
	try {
		await runQueue(TIMERS_QUEUE).add(
			"ring",
			{ conversationId, ringsAt: ringsAt.getTime() },
			{
				jobId: `timer:${conversationId}:${ringsAt.getTime()}`,
				delay: delay * 1000,
				removeOnComplete: true,
				removeOnFail: 1000,
			},
		);
	} catch (error) {
		// it would never ring: drop it rather than show it
		await db
			.delete(timer)
			.where(
				and(
					eq(timer.conversationId, conversationId),
					eq(timer.ringsAt, ringsAt),
				),
			);
		throw error;
	}
	await saved(conversationId);
	return ringsAt;
}

/** Cancels the Conversation's Timer; its job, left queued, then does nothing. True when there was one. */
export async function cancelTimer(conversationId: string) {
	const cancelled = await db
		.delete(timer)
		.where(eq(timer.conversationId, conversationId))
		.returning({ id: timer.conversationId });
	if (cancelled.length) await saved(conversationId);
	return cancelled.length > 0;
}

/**
 * The job of the Timer set to ring at `ringsAt`: unless it was cancelled or replaced, its note goes in the inbox as an input from the Timer,
 * which makes the Conversation's Runs unattended, counts a ring since the User's last message, and wakes it.
 */
export async function ring(conversationId: string, ringsAt: number) {
	const rang = await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		const [row] = await tx
			.delete(timer)
			.where(
				and(
					eq(timer.conversationId, conversationId),
					eq(timer.ringsAt, new Date(ringsAt)),
				),
			)
			.returning();
		if (!row) return false;
		await tx
			.update(conversation)
			.set({
				timerRingsSinceUser: sql`${conversation.timerRingsSinceUser} + 1`,
			})
			.where(eq(conversation.id, conversationId));
		await queueInput(tx, {
			conversationId,
			message: {
				role: "user",
				content: `The timer you set rang. Your note: ${row.note}`,
				timestamp: Date.now(),
			},
			model: row.model,
			thinkingLevel: row.thinkingLevel,
			origin: "timer",
		});
		return true;
	});
	if (!rang) return;
	await saved(conversationId);
	await ensureRun(conversationId);
}
