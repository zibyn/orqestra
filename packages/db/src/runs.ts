import { createPostgresBackend, Queue } from "bullmq";
import { and, asc, count, desc, eq, exists, inArray, sql } from "drizzle-orm";
import {
	AGENT_RUNS_QUEUE,
	conversationChannel,
	db,
	lockRoot,
	MAX_SUBAGENTS,
	STOP_CHANNEL,
	SUBAGENT_RUNS_QUEUE,
	type Tx,
} from "./index.ts";
import { conversation, inbox, message, subagent } from "./schema.ts";

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

/** Queues a Run; marks the Conversation failed when that fails. */
export async function enqueue(conversationId: string, subagents = false) {
	try {
		await runQueue(subagents).add(
			"run",
			{ conversationId },
			{ removeOnComplete: true, removeOnFail: 1000 },
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
			const [{ running }] = await tx
				.select({ running: count() })
				.from(subagent)
				.where(
					and(
						eq(subagent.parentId, conv.parentId),
						eq(subagent.outcome, "running"),
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
			.set({ status: "running" })
			.where(eq(conversation.id, conversationId));
		return conv;
	});
	if (started) await enqueue(conversationId, !!started.parentId);
	return !!started;
}

type Ended = {
	outcome: "completed" | "partial" | "failed" | "stopped";
	result: string;
};

// a Subagent's output may come from any web page: it must not close the tag that frames it
const notification = (number: number, { outcome, result }: Ended) =>
	`<task-notification subagent="${number}" status="${outcome}">\n${result.replaceAll("</task-notification", "<\\/task-notification")}\n</task-notification>`;

/**
 * Under the parent's lock (which `tx` holds): saves how a Subagent ended, sets it idle and hands its result to the parent as a Notification.
 * A stop stands even if the Run ended otherwise meanwhile, and a stopped Subagent neither wakes the parent nor starts again by itself.
 * Returns the parent's id, or undefined when the Subagent is gone.
 */
async function settle(tx: Tx, conversationId: string, ended: Ended) {
	const row = await tx.query.subagent.findFirst({
		where: eq(subagent.conversationId, conversationId),
	});
	if (!row) return undefined;
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
	if (end.outcome === "stopped")
		await tx
			.update(inbox)
			.set({ wake: false })
			.where(eq(inbox.conversationId, conversationId));
	// the Notification is answered on the Model the parent last replied with
	const [last] = await tx
		.select({ model: message.model, thinkingLevel: message.thinkingLevel })
		.from(message)
		.where(eq(message.conversationId, row.parentId))
		.orderBy(desc(message.id))
		.limit(1);
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
	await notifySaved(parentId);
	await ensureRun(parentId);
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
	for (const w of waiting) await ensureRun(w.id);
}

const notifySaved = (conversationId: string) =>
	db.execute(
		sql`select pg_notify(${conversationChannel(conversationId)}, ${JSON.stringify({ type: "saved" })})`,
	);

/** Ends a Subagent's Run that did not drain to the end (stopped, failed or crashed); see `settle`. */
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
 * Queued ones end at once; running ones are marked stopped, which their Run sees when it starts or the stop request reaches it.
 * Returns the numbers it stopped.
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
	for (const r of rows)
		if (r.outcome === "running")
			await db.execute(sql`select pg_notify(${STOP_CHANNEL}, ${r.id})`);
	if (rows.length) await notifySaved(parentId);
	return rows.map((r) => r.number);
}
