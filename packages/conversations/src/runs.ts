import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { messageText } from "@orqestra/config";
import { db, type Tx } from "@orqestra/db";
import {
	conversation,
	type FiringOutcome,
	firing,
	type InputOrigin,
	inbox,
	message,
	type RunFailure,
	scheduledTask,
	subagent,
	timer,
} from "@orqestra/db/schema";
import { createPostgresBackend, Queue } from "bullmq";
import {
	and,
	asc,
	count,
	desc,
	eq,
	exists,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";

/** Locks the row of a Conversation's root, the top-level Conversation of its tree: every Run start and finish in the tree decides under it. */
export const lockRoot = (tx: Tx, conversationId: string) =>
	tx.execute(
		sql`select 1 from ${conversation} where ${conversation.id} = (select ${conversation.rootId} from ${conversation} where ${conversation.id} = ${conversationId}) for update`,
	);

/** The root of a Conversation's tree, whose page shows the whole tree; undefined when it is gone. */
export const rootOf = async (conversationId: string) =>
	(
		await db.query.conversation.findFirst({
			columns: { rootId: true },
			where: eq(conversation.id, conversationId),
		})
	)?.rootId;

/** Matches the `subagent` rows of a parent Conversation's Subagents. */
export const subagentOf = (parentId: string) =>
	inArray(
		subagent.conversationId,
		db
			.select({ id: conversation.id })
			.from(conversation)
			.where(eq(conversation.parentId, parentId)),
	);

/** Subagents of one tree running at once; more wait their turn. */
export const MAX_SUBAGENTS = 4;

/** BullMQ queues with one job `{ conversationId }` per Run: top-level Conversations', and Subagents' apart so these cannot starve them. */
export const AGENT_RUNS_QUEUE = "agent-runs";
export const SUBAGENT_RUNS_QUEUE = "subagent-runs";
/** BullMQ queue with one job `{ taskId }` per Firing: a Job Scheduler per recurring Scheduled Task, a delayed job per one-time one. */
export const FIRINGS_QUEUE = "firings";

/** NOTIFY channel carrying a Conversation's ConversationEvents (worker -> web SSE). */
export const conversationChannel = (conversationId: string) =>
	`conversation_${conversationId}`;

/** NOTIFY channel whose payload is the id of the Conversation whose run should stop (web -> worker). */
export const STOP_CHANNEL = "conversation_stop";

/** Sends a ConversationEvent to the pages showing this Conversation; a Subagent's events go to its root's id. */
export const notify = (conversationId: string, event: ConversationEvent) =>
	db.execute(
		sql`select pg_notify(${conversationChannel(conversationId)}, ${JSON.stringify(event)})`,
	);

/** Tells the pages showing this Conversation that what it shows changed: every change of state sends it. */
export const saved = (conversationId: string) =>
	notify(conversationId, { type: "saved" });

/** Asks whichever worker runs these Conversations' Runs to abort them. */
export const requestStop = (conversationIds: string[]) =>
	Promise.all(
		conversationIds.map((id) =>
			db.execute(sql`select pg_notify(${STOP_CHANNEL}, ${id})`),
		),
	);

// `subagent` is the subagent row id when the streaming reply is a Subagent's; without it, the Conversation's own
export type ConversationEvent =
	| { type: "start"; subagent?: string } // an Agent reply began streaming
	| {
			type: "delta";
			kind: "text" | "thinking";
			index: number;
			delta: string;
			subagent?: string;
	  }
	| { type: "end"; subagent?: string } // that reply finished, saved or failed: reload, then drop its live copy
	| { type: "saved" }; // messages, title, status or compaction changed in the db: reload them

// How Runs start and end, shared by the web app (User messages, stops) and the worker (Subagents, Notifications).

const newQueue = (name: string) =>
	new Queue(
		name,
		{
			connection: {
				connectionString: process.env.DATABASE_URL as string,
				// the api may schedule a Firing before any worker has set up BullMQ's schema
				migrate: true,
			},
		},
		createPostgresBackend,
	);
const queues = new Map<string, ReturnType<typeof newQueue>>();
/** The queue of top-level Runs, of Subagent Runs, of Timers or of Firings. */
export function runQueue(
	name:
		| typeof AGENT_RUNS_QUEUE
		| typeof SUBAGENT_RUNS_QUEUE
		| "timers"
		| typeof FIRINGS_QUEUE,
) {
	const queue = queues.get(name) ?? newQueue(name);
	queues.set(name, queue);
	return queue;
}

/** A new job id for a Run that is starting, saved with its `running` status so `enqueue` can queue it more than once. */
export const newJobId = () => randomUUID();

/**
 * Queues the Run a Conversation's `running` status started, as the job its `jobId` names:
 * queueing it again (the worker's startup requeue racing the start) adds no second job.
 * Marks the Conversation failed when queueing fails.
 */
export async function enqueue(conversationId: string) {
	const conv = await db.query.conversation.findFirst({
		where: eq(conversation.id, conversationId),
	});
	if (!conv) return;
	try {
		await runQueue(conv.parentId ? SUBAGENT_RUNS_QUEUE : AGENT_RUNS_QUEUE).add(
			"run",
			{ conversationId },
			{
				jobId: conv.jobId ?? undefined,
				removeOnComplete: true,
				removeOnFail: 1000,
			},
		);
	} catch (error) {
		await db
			.update(conversation)
			.set({ status: "failed", failure: "error" })
			.where(eq(conversation.id, conversationId));
		throw error;
	}
}

/**
 * Starts a Run for a Conversation that has none, a wake input in its inbox and room to run (a Subagent waits for a free slot);
 * decided under its root's lock, so inputs arriving together start one Run. True when it started one.
 * A Subagent whose Run cannot be queued fails, and its Notification tells the parent; a top-level Conversation's throws.
 */
export async function ensureRun(conversationId: string) {
	const started = await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		const conv = await tx.query.conversation.findFirst({
			where: eq(conversation.id, conversationId),
		});
		if (!conv || conv.status === "running") return undefined;
		const [wake] = await tx
			.select({ id: inbox.id })
			.from(inbox)
			.where(
				and(
					eq(inbox.conversationId, conversationId),
					eq(inbox.wake, true),
					// a Question waits for the User: Notifications go with the reply
					conv.awaitingReply ? isNull(inbox.subagentId) : undefined,
				),
			)
			.limit(1);
		if (!wake) return undefined;
		if (conv.parentId) {
			// counted by Run, not outcome, across the tree: a stopped Subagent holds its slot until its Run has ended,
			// and one waiting idle for its own Subagents holds none
			const [{ running }] = await tx
				.select({ running: count() })
				.from(conversation)
				.where(
					and(
						eq(conversation.rootId, conv.rootId),
						isNotNull(conversation.parentId),
						eq(conversation.status, "running"),
					),
				);
			if (running >= MAX_SUBAGENTS) return undefined;
			await tx
				.update(subagent)
				.set({ outcome: "running" })
				.where(eq(subagent.conversationId, conversationId));
		}
		await tx
			.update(conversation)
			.set({ status: "running", jobId: newJobId() })
			.where(eq(conversation.id, conversationId));
		return conv;
	});
	if (!started) return false;
	try {
		await enqueue(conversationId);
	} catch (error) {
		if (!started.parentId) throw error;
		await endSubagent(conversationId, {
			outcome: "failed",
			result: `[The subagent could not be started: ${(error as Error).message}]`,
		});
	}
	return true;
}

/**
 * Under the root's lock (which `tx` holds): puts an input sent by a Scheduled Task or delivered by a Timer in the inbox, as a wake input,
 * and makes the Conversation's Runs Unattended Runs until the User's next message. The caller then calls `ensureRun`.
 */
export async function queueInput(
	tx: Tx,
	input: Omit<typeof inbox.$inferInsert, "wake" | "subagentId"> & {
		origin: InputOrigin;
	},
) {
	await tx.insert(inbox).values({ ...input, wake: true });
	await tx
		.update(conversation)
		.set({ unattended: true })
		.where(eq(conversation.id, input.conversationId));
}

/** The Model and thinking level of a Conversation's latest message: an input to it without a pick of its own goes on with them. */
export async function lastModel(tx: Tx, conversationId: string) {
	const [last] = await tx
		.select({ model: message.model, thinkingLevel: message.thinkingLevel })
		.from(message)
		.where(eq(message.conversationId, conversationId))
		.orderBy(desc(message.id))
		.limit(1);
	return last as { model: string; thinkingLevel: string } | undefined;
}

/** How a Subagent's Run ended, as its runtime judged it: its Outcome and result; a stop stands whatever is reported. */
export type Ended = {
	outcome: "completed" | "partial" | "failed" | "stopped";
	result: string;
};

// a Subagent's output may come from any web page: it must not close the tag that frames it
const notification = (number: number, { outcome, result }: Ended) =>
	`<task-notification subagent="${number}" status="${outcome}">\n${result.replaceAll("</task-notification", "<\\/task-notification")}\n</task-notification>`;

/**
 * Under the parent's lock (which `tx` holds): saves how a Subagent ended, sets it idle and hands its result to the parent as a Notification.
 * A stop stands even if the Run ended otherwise meanwhile, and a stopped Subagent does not wake the parent.
 * Inputs it left unread wait for the parent to continue it. Settles each Run once: a second call (a crash report after the end) does nothing.
 * Returns the parent's id, or undefined when the Subagent is gone or already settled.
 */
async function settle(tx: Tx, conversationId: string, ended: Ended) {
	const row = await tx.query.subagent.findFirst({
		where: eq(subagent.conversationId, conversationId),
	});
	const conv = await tx.query.conversation.findFirst({
		where: eq(conversation.id, conversationId),
	});
	// idle and neither waiting for a slot nor for its own Subagents: settled already
	if (
		!row ||
		!conv ||
		(conv.status === "idle" && !["queued", "running"].includes(row.outcome))
	)
		return undefined;
	const end =
		row.outcome === "stopped"
			? { ...ended, outcome: "stopped" as const }
			: ended;
	await tx
		.update(subagent)
		.set(end)
		.where(eq(subagent.conversationId, conversationId));
	await tx
		.update(conversation)
		.set({ status: "idle" })
		.where(eq(conversation.id, conversationId));
	await tx
		.update(inbox)
		.set({ wake: false })
		.where(eq(inbox.conversationId, conversationId));
	// the Notification is answered on the Model the parent last replied with
	const parentId = conv.parentId as string;
	const last = await lastModel(tx, parentId);
	// a parent that waits for its Subagents wakes for the last of them, stopped or not, to sum up
	const wake = (await waiting(tx, parentId))
		? !(await busy(tx, parentId))
		: end.outcome !== "stopped";
	await tx.insert(inbox).values({
		conversationId: parentId,
		message: {
			role: "user",
			content: notification(row.number, end),
			timestamp: Date.now(),
		},
		model: last?.model ?? "",
		thinkingLevel: last?.thinkingLevel ?? "off",
		subagentId: conversationId,
		wake,
	});
	return parentId;
}

/** A Subagent's latest reply, which one stopped while it waits for its own passes on: none for one still queued. */
async function lastAnswer(tx: Tx, conversationId: string) {
	const [last] = await tx
		.select({ message: message.message })
		.from(message)
		.where(
			and(
				eq(message.conversationId, conversationId),
				sql`${message.message}->>'role' = 'assistant'`,
			),
		)
		.orderBy(desc(message.id))
		.limit(1);
	return last ? messageText(last.message as Message) : "";
}

/** Whether any of a Conversation's own Subagents is queued or running (or waiting for its own), or stopped but its Run not yet over. */
async function busy(tx: Tx, parentId: string) {
	const [row] = await tx
		.select({ id: subagent.conversationId })
		.from(subagent)
		.innerJoin(conversation, eq(conversation.id, subagent.conversationId))
		.where(
			and(
				subagentOf(parentId),
				or(
					inArray(subagent.outcome, ["queued", "running"]),
					eq(conversation.status, "running"),
				),
			),
		)
		.limit(1);
	return !!row;
}

/** A Subagent whose Run ended while its own Subagents still work: idle, but not yet ended, it holds back its Notification. */
async function waiting(tx: Tx, conversationId: string) {
	const [row] = await tx
		.select({ outcome: subagent.outcome })
		.from(subagent)
		.innerJoin(conversation, eq(conversation.id, subagent.conversationId))
		.where(
			and(
				eq(subagent.conversationId, conversationId),
				eq(conversation.status, "idle"),
			),
		);
	return row?.outcome === "running";
}

/** After a Subagent's Run ended: the parent answers its Notification, and the tree's Subagents waiting for a slot get one. */
async function wakeAfter(parentId: string) {
	const rootId = await rootOf(parentId);
	if (!rootId) return;
	await saved(rootId);
	const waiting = await db
		.select({ id: subagent.conversationId })
		.from(subagent)
		.innerJoin(conversation, eq(conversation.id, subagent.conversationId))
		.where(
			and(
				eq(conversation.rootId, rootId),
				exists(
					db
						.select()
						.from(inbox)
						.where(
							and(
								eq(inbox.conversationId, subagent.conversationId),
								eq(inbox.wake, true),
							),
						),
				),
			),
		)
		.orderBy(asc(conversation.createdAt), asc(subagent.number));
	// one that cannot start is marked failed by ensureRun; the Subagent that ended stays settled either way
	for (const id of [parentId, ...waiting.map((w) => w.id)])
		await ensureRun(id).catch((error) =>
			console.error(`could not start a Run of ${id}`, error),
		);
}

/** Removes a Scheduled Task's Job Scheduler, so it fires no more; a one-time task's delayed job is dropped when it comes due. */
export const unschedule = (taskId: string) =>
	runQueue(FIRINGS_QUEUE).removeJobScheduler(taskId);

/** Failed Firings in a row that pause their Scheduled Task. */
export const MAX_FAILED_FIRINGS = 3;

/**
 * Under the task's lock, or the root's taken before it: counts one more failed Firing of the task, or clears the count,
 * auto-pausing it at MAX_FAILED_FIRINGS. True when that paused it: removing its scheduler is the caller's.
 */
export async function countFiring(tx: Tx, taskId: string, failed: boolean) {
	const [task] = await tx
		.update(scheduledTask)
		.set({
			consecutiveFailures: failed
				? sql`${scheduledTask.consecutiveFailures} + 1`
				: 0,
			state: failed
				? sql`case when ${scheduledTask.consecutiveFailures} + 1 >= ${MAX_FAILED_FIRINGS} and ${scheduledTask.state} = 'active' then 'auto_paused' else ${scheduledTask.state} end`
				: undefined,
		})
		.where(eq(scheduledTask.id, taskId))
		.returning({
			state: scheduledTask.state,
			failures: scheduledTask.consecutiveFailures,
		});
	return (
		failed &&
		task?.state === "auto_paused" &&
		task.failures === MAX_FAILED_FIRINGS
	);
}

/**
 * Under the root's lock: the first Run of a Firing's Conversation ended as `outcome`, which the Firing keeps; later Runs change nothing.
 * Returns the task's id when that failure auto-paused it.
 */
async function endFiring(
	tx: Tx,
	conversationId: string,
	outcome: Exclude<FiringOutcome, "running" | "skipped">,
) {
	const [ended] = await tx
		.update(firing)
		.set({ outcome })
		.where(
			and(
				eq(firing.conversationId, conversationId),
				eq(firing.outcome, "running"),
			),
		)
		.returning({ taskId: firing.taskId });
	if (ended && (await countFiring(tx, ended.taskId, outcome === "failed")))
		return ended.taskId;
}

/** A Firing's Conversation whose Run could not even be queued: the Firing failed. True when that auto-paused its task. */
export async function firingFailed(conversationId: string) {
	const paused = await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		return endFiring(tx, conversationId, "failed");
	});
	if (paused) await unschedule(paused);
	return !!paused;
}

/**
 * Ends a top-level Run that did not drain to the end (stopped, failed or crashed) with `status`, under the root's lock.
 * After a stop, a wake input that arrived meanwhile, such as a User message sent right after Stop, starts the next Run;
 * after a failure the inbox waits for Retry, which delivers it, so the failure still shows.
 * A Firing's first Run ends it failed, or partial when stopped, by the User or out of time. True when that auto-paused its task.
 */
export async function endRun(
	conversationId: string,
	status: "idle" | "failed",
	failure: RunFailure = "error",
) {
	const paused = await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		await tx
			.update(conversation)
			.set({ status, failure: status === "failed" ? failure : null })
			.where(eq(conversation.id, conversationId));
		return endFiring(
			tx,
			conversationId,
			status === "failed" ? "failed" : "partial",
		);
	});
	if (paused) await unschedule(paused);
	await saved(conversationId);
	if (status === "idle") await ensureRun(conversationId);
	return !!paused;
}

/** Ends a Subagent's Run that did not drain to the end (stopped, failed, crashed or never queued); see `settle`. */
export async function endSubagent(conversationId: string, ended: Ended) {
	const parentId = await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		return settle(tx, conversationId, ended);
	});
	if (parentId) await wakeAfter(parentId);
}

/**
 * Delivers a Conversation's inbox into `message`, in arrival order, under its root's lock; returns what it delivered.
 * With `finish`, an inbox without a wake input ends the Run instead: the Conversation goes idle and Unread, and a Subagent's settles with how it `finish`ed.
 * A `"question"` finish waits for the User: only their message goes on, and it ends awaiting their reply, its Timer cancelled.
 * A top-level Run ends completed, or `"partial"` at an Unattended Run's step cap; a Firing's first Run records how.
 * That is checked under the same lock a sender starts a Run under, so no input is left behind.
 */
export async function drain(
	conversationId: string,
	finish: boolean | "question" | "partial" | (() => Ended) = false,
) {
	let parentId: string | undefined;
	const delivered = await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		// at the end, inputs that do not wake it wait for the next Run
		const [wake] = finish
			? await tx
					.select({ id: inbox.id })
					.from(inbox)
					.where(
						and(
							eq(inbox.conversationId, conversationId),
							eq(inbox.wake, true),
							finish === "question" ? isNull(inbox.subagentId) : undefined,
						),
					)
					.limit(1)
			: [true];
		const inputs = wake
			? (
					await tx
						.delete(inbox)
						.where(eq(inbox.conversationId, conversationId))
						.returning()
				).sort((a, b) => a.id - b.id)
			: [];
		if (inputs.length)
			await tx.insert(message).values(
				inputs.map((i) => ({
					conversationId,
					message: i.message,
					model: i.model,
					thinkingLevel: i.thinkingLevel,
					subagentId: i.subagentId,
					origin: i.origin,
				})),
			);
		else if (typeof finish === "function") {
			// its own Subagents still work: it waits for them idle, freeing its slot, and ends with a summary Run once they are done;
			// a stopped one has nothing to sum up for
			const own = await tx.query.subagent.findFirst({
				columns: { outcome: true },
				where: eq(subagent.conversationId, conversationId),
			});
			if (own?.outcome !== "stopped" && (await busy(tx, conversationId))) {
				await tx
					.update(conversation)
					.set({ status: "idle" })
					.where(eq(conversation.id, conversationId));
				parentId = (
					await tx.query.conversation.findFirst({
						columns: { parentId: true },
						where: eq(conversation.id, conversationId),
					})
				)?.parentId as string;
			} else parentId = await settle(tx, conversationId, finish());
		} else if (finish) {
			// asking a Question cancels the Timer: the User's answer is what it waits for
			if (finish === "question")
				await tx.delete(timer).where(eq(timer.conversationId, conversationId));
			// it ends with its reply, which the User has yet to see
			await tx
				.update(conversation)
				.set({
					status: "idle",
					unread: true,
					awaitingReply: finish === "question",
				})
				.where(eq(conversation.id, conversationId));
			// none of these is a failure, so none pauses the task
			await endFiring(
				tx,
				conversationId,
				finish === true ? "completed" : finish,
			);
		}
		// pi UserMessages
		return inputs.map((i) => i.message);
	});
	if (parentId) await wakeAfter(parentId);
	return delivered;
}

/**
 * Stops a parent's Subagents (those `numbers`, else all) that are queued or running, and every Subagent under them.
 * Those without a Run end at once, one waiting for its own Subagents with its last answer; running ones are marked stopped,
 * which their Run sees when it starts or the stop request reaches it, and keep their slot until it ends.
 * Their Notifications wake nobody, except a parent waiting for its Subagents, which sums up once the last has ended, stopped ones' Runs included.
 * Returns the numbers of the parent's own it stopped.
 */
export async function stopSubagents(parentId: string, numbers?: number[]) {
	const { targets, running } = await db.transaction(async (tx) => {
		await lockRoot(tx, parentId);
		const targets = await tx
			.select({ id: subagent.conversationId, number: subagent.number })
			.from(subagent)
			.where(
				and(
					subagentOf(parentId),
					inArray(subagent.outcome, ["queued", "running"]),
					numbers && inArray(subagent.number, numbers),
				),
			);
		if (!targets.length) return { targets, running: [] };
		// with the subtrees below them, shallowest first, so a parent is stopped before its Subagents settle
		const { rows } = await tx.execute<{ id: string; status: string }>(
			sql`with recursive tree as (
				select id from conversation where id in ${targets.map((t) => t.id)}
				union all
				select c.id from conversation c join tree on c.parent_id = tree.id
			)
			select c.id, c.status from tree
			join conversation c on c.id = tree.id
			join subagent s on s.conversation_id = c.id
			where s.outcome in ('queued', 'running')
			order by c.depth`,
		);
		const running = rows.filter((r) => r.status === "running").map((r) => r.id);
		if (running.length)
			await tx
				.update(subagent)
				.set({ outcome: "stopped" })
				.where(inArray(subagent.conversationId, running));
		for (const r of rows)
			if (r.status !== "running")
				await settle(tx, r.id, {
					outcome: "stopped",
					result: await lastAnswer(tx, r.id),
				});
		return { targets, running };
	});
	if (!targets.length) return [];
	await requestStop(running);
	await wakeAfter(parentId);
	return targets.map((t) => t.number);
}
