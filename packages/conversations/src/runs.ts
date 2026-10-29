import { randomUUID } from "node:crypto";
import { db, type Tx } from "@orqestra/db";
import { conversation, inbox, message, subagent } from "@orqestra/db/schema";
import { createPostgresBackend, Queue } from "bullmq";
import { and, asc, count, desc, eq, exists, inArray, sql } from "drizzle-orm";

/** Locks the row of a Conversation's root (a Subagent's parent, else itself): every Run start and finish decides under it. */
export const lockRoot = (tx: Tx, conversationId: string) =>
	tx.execute(
		sql`select 1 from ${conversation} where ${conversation.id} = (select coalesce(${conversation.parentId}, ${conversation.id}) from ${conversation} where ${conversation.id} = ${conversationId}) for update`,
	);

/** Subagents of one parent Conversation running at once; more wait their turn. */
export const MAX_SUBAGENTS = 4;

/** BullMQ queues with one job `{ conversationId }` per Run: top-level Conversations', and Subagents' apart so these cannot starve them. */
export const AGENT_RUNS_QUEUE = "agent-runs";
export const SUBAGENT_RUNS_QUEUE = "subagent-runs";

/** NOTIFY channel carrying a Conversation's ConversationEvents (worker -> web SSE). */
export const conversationChannel = (conversationId: string) =>
	`conversation_${conversationId}`;

/** NOTIFY channel whose payload is the id of the Conversation whose run should stop (web -> worker). */
export const STOP_CHANNEL = "conversation_stop";

/** Sends a ConversationEvent to the pages showing this Conversation; a Subagent's events go to its parent's id. */
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
		{ connection: { connectionString: process.env.DATABASE_URL as string } },
		createPostgresBackend,
	);
const queues = new Map<string, ReturnType<typeof newQueue>>();
/** The queue of top-level Runs, or with `subagents` of Subagent Runs. */
export function runQueue(subagents = false) {
	const name = subagents ? SUBAGENT_RUNS_QUEUE : AGENT_RUNS_QUEUE;
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
		await runQueue(!!conv.parentId).add(
			"run",
			{ conversationId },
			{
				// Runs started before job ids were saved: their Conversation's id
				jobId: conv.jobId ?? conversationId,
				removeOnComplete: true,
				removeOnFail: 1000,
			},
		);
	} catch (error) {
		await db
			.update(conversation)
			.set({ status: "failed" })
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
				and(eq(inbox.conversationId, conversationId), eq(inbox.wake, true)),
			)
			.limit(1);
		if (!wake) return undefined;
		if (conv.parentId) {
			// counted by Run, not outcome: a stopped Subagent holds its slot until its Run has ended
			const [{ running }] = await tx
				.select({ running: count() })
				.from(conversation)
				.where(
					and(
						eq(conversation.parentId, conv.parentId),
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
	// idle with no Run waiting for a slot: settled already
	if (!row || !conv || (conv.status === "idle" && row.outcome !== "queued"))
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
	const last = await lastModel(tx, row.parentId);
	await tx.insert(inbox).values({
		conversationId: row.parentId,
		message: {
			role: "user",
			content: notification(row.number, end),
			timestamp: Date.now(),
		},
		model: last?.model ?? "",
		thinkingLevel: last?.thinkingLevel ?? "off",
		subagentId: conversationId,
		wake: end.outcome !== "stopped",
	});
	return row.parentId;
}

/** After a Subagent ended: the parent answers its Notification, and the Subagents waiting for a slot get one. */
async function wakeAfter(parentId: string) {
	await saved(parentId);
	const waiting = await db
		.select({ id: subagent.conversationId })
		.from(subagent)
		.where(
			and(
				eq(subagent.parentId, parentId),
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
		.orderBy(asc(subagent.number));
	// one that cannot start is marked failed by ensureRun; the Subagent that ended stays settled either way
	for (const id of [parentId, ...waiting.map((w) => w.id)])
		await ensureRun(id).catch((error) =>
			console.error(`could not start a Run of ${id}`, error),
		);
}

/**
 * Ends a top-level Run that did not drain to the end (stopped, failed or crashed) with `status`, under the root's lock.
 * After a stop, a wake input that arrived meanwhile, such as a User message sent right after Stop, starts the next Run;
 * after a failure the inbox waits for Retry, which delivers it, so the failure still shows.
 */
export async function endRun(
	conversationId: string,
	status: "idle" | "failed",
) {
	await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		await tx
			.update(conversation)
			.set({ status })
			.where(eq(conversation.id, conversationId));
	});
	await saved(conversationId);
	if (status === "idle") await ensureRun(conversationId);
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
 * With `finish`, an inbox without a wake input ends the Run instead: the Conversation goes idle, and a Subagent's settles with how it `finish`ed.
 * That is checked under the same lock a sender starts a Run under, so no input is left behind.
 */
export async function drain(
	conversationId: string,
	finish: boolean | (() => Ended) = false,
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
						and(eq(inbox.conversationId, conversationId), eq(inbox.wake, true)),
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
				})),
			);
		else if (typeof finish === "function")
			parentId = await settle(tx, conversationId, finish());
		else if (finish)
			await tx
				.update(conversation)
				.set({ status: "idle" })
				.where(eq(conversation.id, conversationId));
		// pi UserMessages
		return inputs.map((i) => i.message);
	});
	if (parentId) await wakeAfter(parentId);
	return delivered;
}

/**
 * Stops a parent's Subagents (those `numbers`, else all) that are queued or running.
 * Queued ones end at once; running ones are marked stopped, which their Run sees when it starts or the stop request reaches it,
 * and keep their slot until it ends. Returns the numbers it stopped.
 */
export async function stopSubagents(parentId: string, numbers?: number[]) {
	const rows = await db.transaction(async (tx) => {
		await lockRoot(tx, parentId);
		const rows = await tx
			.select({
				id: subagent.conversationId,
				number: subagent.number,
				outcome: subagent.outcome,
			})
			.from(subagent)
			.where(
				and(
					eq(subagent.parentId, parentId),
					inArray(subagent.outcome, ["queued", "running"]),
					numbers && inArray(subagent.number, numbers),
				),
			);
		for (const r of rows)
			if (r.outcome === "queued")
				await settle(tx, r.id, { outcome: "stopped", result: "" });
		const running = rows.filter((r) => r.outcome === "running");
		if (running.length)
			await tx
				.update(subagent)
				.set({ outcome: "stopped" })
				.where(
					inArray(
						subagent.conversationId,
						running.map((r) => r.id),
					),
				);
		return rows;
	});
	await requestStop(
		rows.filter((r) => r.outcome === "running").map((r) => r.id),
	);
	if (rows.length) await saved(parentId);
	return rows.map((r) => r.number);
}
