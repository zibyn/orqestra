import { randomUUID } from "node:crypto";
import type { OrqestraConfig } from "@orqestra/config";
import { db } from "@orqestra/db";
import {
	backgroundCall,
	conversation,
	inbox,
	message,
} from "@orqestra/db/schema";
import {
	type BackgroundCallStart,
	cancelMcpTask,
	type Fetch,
	INPUT_REQUIRED,
	type McpServer,
	type McpTaskState,
	pollMcpTask,
} from "@orqestra/tools";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alertRun } from "./alerts.ts";
import {
	endIdleFiring,
	ensureRun,
	lastModel,
	lockRoot,
	notificationFrame,
	rootOf,
	runQueue,
	saved,
	spend,
	unschedule,
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
/** How long since the last answer a server that cannot be asked is given before its Background Call ends failed. */
const UNREACHABLE_MS = 5 * 60_000;

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
	const cfg = await config();
	const server = cfg.mcpServers[row.mcpServerId];
	if (!server)
		return end(
			row,
			{ status: "failed", message: "The MCP Server has been disabled." },
			row.mcpServerId,
		);
	const reference = row.reference as BackgroundCallStart["reference"];
	const maxSeconds = cfg.limits.backgroundCallMaxDuration;
	if (Date.now() - row.startedAt.getTime() >= maxSeconds * 1000)
		return cancelAndEnd(row, server, fetch, {
			status: "failed",
			message: `The call ran longer than the ${maxSeconds} seconds Orqestra tracks a Background Call, so it was cancelled.`,
		});
	let state: McpTaskState | undefined;
	try {
		state = await pollMcpTask(server, reference, {
			fetch,
			timeoutMs: POLL_TIMEOUT_MS,
		});
	} catch (error) {
		// network errors, timeouts, 5xx: asked again at the interval, until it has been too long since an answer
		console.error(`could not poll Background Call ${id}`, error);
		if (Date.now() - row.polledAt.getTime() >= UNREACHABLE_MS)
			return end(
				row,
				{
					status: "failed",
					message: "The service could not be reached for 5 minutes.",
				},
				server.name,
			);
	}
	if (state && state.status !== "working")
		return state.status === "input_required"
			? cancelAndEnd(row, server, fetch, {
					status: "failed",
					message: INPUT_REQUIRED,
				})
			: end(row, state as Ending, server.name);
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

/** Asks the server to cancel the task, giving up when it cannot be reached, then ends the Background Call as `state`. */
async function cancelAndEnd(
	row: Row,
	server: McpServer,
	fetch: Fetch | undefined,
	state: Ending,
) {
	await cancelMcpTask(
		server,
		row.reference as BackgroundCallStart["reference"],
		{ fetch, timeoutMs: POLL_TIMEOUT_MS },
	).catch((error) =>
		console.error(`could not cancel Background Call ${row.id}`, error),
	);
	await end(row, state, server.name);
}

/**
 * Before an Admin deletes the MCP Server: cancels each of its Background Calls still running and ends it failed.
 * One of a disabled server (not in `config`) ends at its next poll instead.
 */
export async function endBackgroundCallsOf(
	config: () => Promise<OrqestraConfig>,
	mcpServerId: string,
	fetch?: Fetch,
) {
	const server = (await config()).mcpServers[mcpServerId];
	if (!server) return;
	const rows = await db
		.select()
		.from(backgroundCall)
		.where(
			and(
				eq(backgroundCall.mcpServerId, mcpServerId),
				eq(backgroundCall.status, "running"),
			),
		);
	for (const row of rows)
		await cancelAndEnd(row, server, fetch, {
			status: "failed",
			message: "The MCP Server has been deleted.",
		});
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

/** A Background Call to cancel with its MCP Server. */
export type CancelledCall = Pick<Row, "mcpServerId" | "reference">;

/**
 * Asks each call's MCP Server, as configured now, once to cancel its task, without waiting for that:
 * one disabled, deleted or unreachable is given up on.
 */
export async function cancelTasks(
	config: () => Promise<OrqestraConfig>,
	calls: CancelledCall[],
	fetch?: Fetch,
) {
	if (!calls.length) return;
	const servers = (await config()).mcpServers;
	for (const call of calls) {
		const server = servers[call.mcpServerId];
		if (server)
			void cancelMcpTask(
				server,
				call.reference as BackgroundCallStart["reference"],
				{ fetch, timeoutMs: POLL_TIMEOUT_MS },
			).catch((error) =>
				console.error("could not cancel a Background Call's task", error),
			);
	}
}

/** What `stopSubagents` cancels each stopped Subagent's Background Calls with. */
export const cancelStopped =
	(config: () => Promise<OrqestraConfig>, fetch?: Fetch) => (id: string) =>
		cancelBackgroundCalls(config, id, "stop", fetch);

/**
 * Under the root's lock: stops tracking running Background Calls as cancelled, each with a Notification that wakes nobody
 * and goes with the next input, then cancels their tasks. By the User: the call `toolCallId` in the tree of the top-level
 * Conversation `conversationId`; by Stop: all of the Conversation `conversationId`'s. Returns how many it cancelled.
 */
export async function cancelBackgroundCalls(
	config: () => Promise<OrqestraConfig>,
	conversationId: string,
	by: { toolCallId: string } | "stop",
	fetch?: Fetch,
) {
	const cfg = await config();
	const ended = await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		const rows = await tx
			.update(backgroundCall)
			.set({ status: "cancelled" })
			.where(
				and(
					eq(backgroundCall.status, "running"),
					by === "stop"
						? eq(backgroundCall.conversationId, conversationId)
						: and(
								eq(backgroundCall.toolCallId, by.toolCallId),
								inArray(
									backgroundCall.conversationId,
									tx
										.select({ id: conversation.id })
										.from(conversation)
										.where(eq(conversation.rootId, conversationId)),
								),
							),
				),
			)
			.returning();
		for (const row of rows) {
			// the Notification is answered on the Model the Conversation last replied with
			const last = await lastModel(tx, row.conversationId);
			await tx.insert(inbox).values({
				conversationId: row.conversationId,
				message: {
					role: "user",
					content: notificationFrame(
						{
							server: cfg.mcpServers[row.mcpServerId]?.name ?? row.mcpServerId,
							tool: row.toolName,
							status: "cancelled",
						},
						by === "stop"
							? "The call was cancelled as the User stopped the Conversation: no result will come."
							: "The User cancelled the call: no result will come.",
					),
					timestamp: Date.now(),
				},
				model: last?.model ?? "",
				thinkingLevel: last?.thinkingLevel ?? "off",
				backgroundCallId: row.id,
				wake: false,
			});
		}
		// waking nothing, it may have been the last its Firing waited for
		const rootId = rows.length ? await rootOf(conversationId) : undefined;
		const fired = rootId
			? await endIdleFiring(tx, rootId, by === "stop")
			: undefined;
		return { rows, rootId, fired };
	});
	const { rows: cancelled, rootId, fired } = ended;
	if (!cancelled.length) return 0;
	if (rootId) await saved(rootId);
	if (fired?.paused) await unschedule(fired.taskId);
	// a Stop of the User's sends no Alert
	if (rootId && fired && by !== "stop")
		await alertRun(rootId, fired.paused ? "auto_paused" : fired.outcome);
	await cancelTasks(async () => cfg, cancelled, fetch);
	return cancelled.length;
}
