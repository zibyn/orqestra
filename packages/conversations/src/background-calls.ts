import { randomUUID } from "node:crypto";
import type { OrqestraConfig } from "@orqestra/config";
import { db } from "@orqestra/db";
import { backgroundCall, inbox, message } from "@orqestra/db/schema";
import {
	type BackgroundCallStart,
	type Fetch,
	type McpTaskState,
	pollMcpTask,
} from "@orqestra/tools";
import { and, eq, sql } from "drizzle-orm";
import {
	ensureRun,
	lastModel,
	lockRoot,
	notificationFrame,
	rootOf,
	runQueue,
	saved,
	spend,
} from "./runs.ts";

// A Background Call is its `background_call` row: polled by delayed jobs that carry only its id, one at a time,
// until it ends; a job that finds it gone, ended or polled by a later job does nothing.

/** BullMQ queue of delayed jobs `{ backgroundCallId }`, one per poll. */
export const BACKGROUND_CALLS_QUEUE = "background-calls";
/** How soon to poll again, in ms, when the server suggests nothing, and the bounds put on what it suggests. */
const DEFAULT_POLL_MS = 2000;
const MIN_POLL_MS = 250;
const MAX_POLL_MS = 30_000;
/** How long one MCP request of a poll may take. */
const POLL_TIMEOUT_MS = 60_000;

type Row = typeof backgroundCall.$inferSelect;
type Ending = Exclude<McpTaskState, { status: "working" | "input_required" }>;

/** Queues the poll the row's `jobId` names; queueing it again (the startup requeue) adds no second job. */
const schedule = (id: string, jobId: string, delay: number) =>
	runQueue(BACKGROUND_CALLS_QUEUE).add(
		"poll",
		{ backgroundCallId: id },
		{ jobId, delay, removeOnComplete: true, removeOnFail: 1000 },
	);

/**
 * Under the root's lock: starts tracking a Tool call of the Conversation's Agent that its MCP Server put in the background,
 * spending one of the tree's budget, and queues its first poll. Returns its id; throws BudgetExceeded, tracking nothing.
 */
export async function startBackgroundCall(
	conversationId: string,
	call: BackgroundCallStart,
) {
	const rootId = await rootOf(conversationId);
	const row = await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		if (rootId) await spend(tx, rootId, 1);
		const [row] = await tx
			.insert(backgroundCall)
			.values({
				conversationId,
				toolCallId: call.toolCallId,
				mcpServerId: call.serverId,
				toolName: call.toolName,
				reference: call.reference,
				jobId: randomUUID(),
				// the Tool call's message, saved before the Tool runs, or a later one of its Turn
				messageId: sql`(select max(${message.id}) from ${message} where ${message.conversationId} = ${conversationId})`,
			})
			.returning();
		return row;
	});
	// a poll that cannot be queued now is queued when a worker next starts
	await schedule(row.id, row.jobId, DEFAULT_POLL_MS).catch((error) =>
		console.error(`could not queue Background Call ${row.id}'s poll`, error),
	);
	if (rootId) await saved(rootId);
	return row.id;
}

/**
 * The job of one poll: asks the MCP Server, as configured now, once how the task stands; queues the next poll
 * after the interval it suggests, or ends the Background Call.
 */
export async function pollBackgroundCall(
	config: () => Promise<OrqestraConfig>,
	id: string,
	jobId: string,
	fetch?: Fetch,
) {
	const row = await db.query.backgroundCall.findFirst({
		where: eq(backgroundCall.id, id),
	});
	if (!row || row.status !== "running" || row.jobId !== jobId) return;
	const server = (await config()).mcpServers[row.mcpServerId];
	if (!server)
		return end(
			row,
			{ status: "failed", message: "The MCP Server has been disabled." },
			row.mcpServerId,
		);
	let state: McpTaskState | undefined;
	try {
		state = await pollMcpTask(
			server,
			row.reference as BackgroundCallStart["reference"],
			{ fetch, timeoutMs: POLL_TIMEOUT_MS },
		);
	} catch (error) {
		// shortcut: a server that cannot be asked is asked again, without end; give up on one gone for good once failures are handled
		console.error(`could not poll Background Call ${id}`, error);
	}
	if (state && state.status !== "working" && state.status !== "input_required")
		return end(row, state as Ending, server.name);
	const next = randomUUID();
	await db
		.update(backgroundCall)
		.set({ jobId: next, ...(state && { polledAt: new Date() }) })
		.where(and(eq(backgroundCall.id, id), eq(backgroundCall.jobId, jobId)));
	await schedule(
		id,
		next,
		Math.min(
			MAX_POLL_MS,
			Math.max(MIN_POLL_MS, state?.pollIntervalMs ?? DEFAULT_POLL_MS),
		),
	);
}

/**
 * Queues again the polls of Background Calls left without a job, lost to a crash between saving one and queueing it.
 * Each is queued as the job its row names, so one that has its job gets no second one.
 */
export async function requeueBackgroundCalls() {
	const running = await db
		.select({ id: backgroundCall.id, jobId: backgroundCall.jobId })
		.from(backgroundCall)
		.where(eq(backgroundCall.status, "running"));
	for (const r of running) await schedule(r.id, r.jobId, 0);
}

/** What the Agent is told of how its Background Call ended, and whether as a Tool's error. */
function told(state: Ending) {
	if (state.status === "completed")
		return state.content
			.map((c) =>
				c.type === "text" ? c.text : `[image ${c.mimeType} omitted]`,
			)
			.join("\n");
	if (state.status === "failed") return `The call failed: ${state.message}`;
	return "The service cancelled the call: no result will come.";
}

/** Under the root's lock: ends the Background Call as `state` and hands that to its Conversation as a Notification, which wakes it. */
async function end(row: Row, state: Ending, server: string) {
	const ended = await db.transaction(async (tx) => {
		await lockRoot(tx, row.conversationId);
		const [ended] = await tx
			.update(backgroundCall)
			.set({ status: state.status })
			.where(
				and(
					eq(backgroundCall.id, row.id),
					eq(backgroundCall.status, "running"),
				),
			)
			.returning({ id: backgroundCall.id });
		if (!ended) return false;
		// the Notification is answered on the Model the Conversation last replied with
		const last = await lastModel(tx, row.conversationId);
		await tx.insert(inbox).values({
			conversationId: row.conversationId,
			message: {
				role: "user",
				content: notificationFrame(
					{
						server,
						tool: row.toolName,
						status: state.status,
						// MCP reports a Tool's failure in its result: the Agent takes it as that Tool's error
						...(state.status === "completed" && state.isError
							? { error: "true" }
							: {}),
					},
					told(state),
				),
				timestamp: Date.now(),
			},
			model: last?.model ?? "",
			thinkingLevel: last?.thinkingLevel ?? "off",
			backgroundCallId: row.id,
			wake: true,
		});
		return true;
	});
	if (!ended) return;
	const rootId = await rootOf(row.conversationId);
	if (rootId) await saved(rootId);
	await ensureRun(row.conversationId);
}
