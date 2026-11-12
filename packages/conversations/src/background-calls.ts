import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { db, type Tx } from "@orqestra/db";
import {
	backgroundCall,
	conversation,
	inbox,
	message,
} from "@orqestra/db/schema";
import {
	type BackgroundCallStart,
	cancelMcpTask,
	INPUT_REQUIRED,
	type McpAccess,
	type McpServer,
	type McpTaskState,
	pollMcpTask,
	signIn,
	type TaskRequestOptions,
} from "@orqestra/mcp";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { OrqestraConfig } from "./capabilities.ts";
import {
	busy,
	ensureRun,
	lastModel,
	linkTo,
	lockRoot,
	notificationFrame,
	rootOf,
	runQueue,
	saved,
	spend,
	waiting,
} from "./runs.ts";
import type { TraceCarrier } from "./serve.ts";

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
/** The ext-tasks reference a row keeps, to resume or cancel the call by. */
const referenceOf = (row: Pick<Row, "reference">) =>
	row.reference as BackgroundCallStart["reference"];
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
	trace?: TraceCarrier,
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
				trace,
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
	mcp: McpAccess = {},
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
	const authProvider =
		server.auth === "oauth"
			? await signInOrEnding(row, server, mcp)
			: undefined;
	if (authProvider && "status" in authProvider)
		return end(row, authProvider, server.name);
	const request = { fetch: mcp.fetch, authProvider };
	const maxSeconds = cfg.limits.backgroundCallMaxDuration;
	if (Date.now() - row.startedAt.getTime() >= maxSeconds * 1000)
		return cancelAndEnd(row, server, request, {
			status: "failed",
			message: `The call ran longer than the ${maxSeconds} seconds Orqestra tracks a Background Call, so it was cancelled.`,
		});
	let state: McpTaskState | undefined;
	try {
		state = await pollMcpTask(server, referenceOf(row), {
			...request,
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
			? cancelAndEnd(row, server, request, {
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

/**
 * How a poll of a per-User OAuth server signs in: as the User of the row's Conversation (a Subagent's is its top-level
 * Conversation's User); else how the Background Call ends, its Connection gone or needing reconnecting.
 */
async function signInOrEnding(
	row: Row,
	server: McpServer,
	mcp: McpAccess,
): Promise<NonNullable<TaskRequestOptions["authProvider"]> | Ending> {
	const conv = await db.query.conversation.findFirst({
		columns: { userId: true },
		where: eq(conversation.id, row.conversationId),
	});
	if (conv && mcp.connections) {
		const provider = await signIn(server, row.mcpServerId, conv.userId, mcp);
		if (provider) return provider;
		if (await mcp.connections.connection(conv.userId, row.mcpServerId))
			return {
				status: "failed",
				message: "The User's Connection to the service needs reconnecting.",
			};
	}
	return {
		status: "failed",
		message:
			"The User's Connection to the service is gone: they disconnected, or an Admin reconfigured its MCP Server.",
	};
}

/** Asks the server to cancel the task, giving up when it cannot be reached, then ends the Background Call as `state`. */
async function cancelAndEnd(
	row: Row,
	server: McpServer,
	request: Omit<TaskRequestOptions, "timeoutMs">,
	state: Ending,
) {
	await cancelMcpTask(server, referenceOf(row), {
		...request,
		timeoutMs: POLL_TIMEOUT_MS,
	}).catch((error) =>
		console.error(`could not cancel Background Call ${row.id}`, error),
	);
	await end(row, state, server.name);
}

/** Before an Admin deletes the MCP Server, disabled or not: cancels each of its Background Calls still running and ends it failed. */
export async function endBackgroundCallsOf(
	config: () => Promise<OrqestraConfig>,
	mcpServerId: string,
	{ fetch }: McpAccess = {},
) {
	const server = (await config()).allMcpServers[mcpServerId];
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
	// its Connections go with it, so a per-User OAuth server is asked without one
	for (const row of rows)
		await cancelAndEnd(
			row,
			server,
			{ fetch },
			{
				status: "failed",
				message: "The MCP Server has been deleted.",
			},
		);
}

type NotificationContent = { text: string; images: ImageContent[] };

/**
 * What the Agent gets of how its Background Call ended: the text its Notification frames and, of a result,
 * the images after it, converted and cut as an immediate result is.
 */
function endingContent(state: Ending): NotificationContent {
	if (state.status === "completed")
		return {
			text: state.content
				.flatMap((c) => (c.type === "text" ? [c.text] : []))
				.join("\n"),
			images: state.content.filter((c) => c.type === "image"),
		};
	return {
		text:
			state.status === "failed"
				? `The call failed: ${state.message}`
				: "The service cancelled the call: no result will come.",
		images: [],
	};
}

/**
 * Under the root's lock: puts the Notification of how the Background Call ended in its Conversation's inbox,
 * to be answered on the Model that Conversation last replied with.
 */
async function insertNotification(
	tx: Tx,
	row: Row,
	{
		server,
		...frame
	}: { server: string; status: Row["status"]; error?: "true" },
	{ text, images }: NotificationContent,
	wake: boolean,
) {
	const last = await lastModel(tx, row.conversationId);
	const framed = notificationFrame(
		{ server, tool: row.toolName, ...frame },
		text,
	);
	await tx.insert(inbox).values({
		conversationId: row.conversationId,
		message: {
			role: "user",
			content: images.length
				? [{ type: "text", text: framed }, ...images]
				: framed,
			timestamp: Date.now(),
		},
		model: last?.model ?? "",
		thinkingLevel: last?.thinkingLevel ?? "off",
		backgroundCallId: row.id,
		trace: linkTo(row.trace),
		wake,
	});
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
		await insertNotification(
			tx,
			row,
			{
				server,
				status: state.status,
				// MCP reports a Tool's failure in its result: the Agent takes it as that Tool's error
				...(state.status === "completed" && state.isError
					? { error: "true" as const }
					: {}),
			},
			endingContent(state),
			true,
		);
		return true;
	});
	if (!ended) return;
	const rootId = await rootOf(row.conversationId);
	if (rootId) await saved(rootId);
	await ensureRun(row.conversationId);
}

/** A Background Call to cancel with its MCP Server, as the User whose Conversation made it. */
export type CancelledCall = Pick<Row, "mcpServerId" | "reference"> & {
	userId: string;
};

/** The Background Calls still running that match `where`, to cancel once what made them is gone. */
export const runningCalls = (
	tx: Pick<Tx, "select">,
	where: SQL | undefined,
): Promise<CancelledCall[]> =>
	tx
		.select({
			mcpServerId: backgroundCall.mcpServerId,
			reference: backgroundCall.reference,
			userId: conversation.userId,
		})
		.from(backgroundCall)
		.innerJoin(conversation, eq(conversation.id, backgroundCall.conversationId))
		.where(and(eq(backgroundCall.status, "running"), where));

/**
 * Asks each call's MCP Server, as configured now, once to cancel the call, without waiting for that:
 * one disabled, deleted or unreachable is given up on.
 */
export async function askToCancel(
	config: () => Promise<OrqestraConfig>,
	calls: CancelledCall[],
	mcp: McpAccess = {},
) {
	if (!calls.length) return;
	const servers = (await config()).mcpServers;
	for (const call of calls) {
		const server = servers[call.mcpServerId];
		if (!server) continue;
		void (async () =>
			cancelMcpTask(server, referenceOf(call), {
				fetch: mcp.fetch,
				timeoutMs: POLL_TIMEOUT_MS,
				authProvider:
					server.auth === "oauth"
						? await signIn(server, call.mcpServerId, call.userId, mcp)
						: undefined,
			}))().catch((error) =>
			console.error("could not cancel a Background Call", error),
		);
	}
}

/**
 * Under the root's lock: stops tracking the running Background Calls that match `where` as cancelled, each with a Notification
 * saying `body`, which wakes its Conversation only when `wake` says so; then asks their servers to cancel them. Returns those it cancelled.
 */
async function cancel(
	config: () => Promise<OrqestraConfig>,
	conversationId: string,
	where: SQL | undefined,
	body: string,
	wake: (tx: Tx, conversationId: string) => Promise<boolean>,
	mcp?: McpAccess,
) {
	const cfg = await config();
	const { cancelled, userId } = await db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		// the whole tree is one User's
		const [owner] = await tx
			.select({ userId: conversation.userId })
			.from(conversation)
			.where(eq(conversation.id, conversationId));
		const rows = await tx
			.update(backgroundCall)
			.set({ status: "cancelled" })
			.where(and(eq(backgroundCall.status, "running"), where))
			.returning();
		for (const row of rows)
			await insertNotification(
				tx,
				row,
				{
					server: cfg.allMcpServers[row.mcpServerId]?.name ?? row.mcpServerId,
					status: "cancelled",
				},
				{ text: body, images: [] },
				await wake(tx, row.conversationId),
			);
		return { cancelled: rows, userId: owner?.userId ?? "" };
	});
	if (!cancelled.length) return cancelled;
	const rootId = await rootOf(conversationId);
	if (rootId) await saved(rootId);
	await askToCancel(
		async () => cfg,
		cancelled.map((row) => ({ ...row, userId })),
		mcp,
	);
	return cancelled;
}

/**
 * Cancels, at the User's request, the Background Call of the Tool call `toolCallId` in the tree of the top-level Conversation `rootId`.
 * Its Notification wakes nobody and goes with the next input, except a Subagent's that waited for nothing else, which sums up;
 * the Firing may have waited for nothing else either. False when there was none running.
 */
export async function cancelBackgroundCall(
	config: () => Promise<OrqestraConfig>,
	rootId: string,
	toolCallId: string,
	mcp?: McpAccess,
) {
	const cancelled = await cancel(
		config,
		rootId,
		and(
			eq(backgroundCall.toolCallId, toolCallId),
			inArray(
				backgroundCall.conversationId,
				db
					.select({ id: conversation.id })
					.from(conversation)
					.where(eq(conversation.rootId, rootId)),
			),
		),
		"The User cancelled the call: no result will come.",
		async (tx, id) => (await waiting(tx, id)) && !(await busy(tx, id)),
		mcp,
	);
	for (const row of cancelled) await ensureRun(row.conversationId);
	return cancelled.length > 0;
}

/**
 * The Conversation `conversationId` was stopped: cancels its own running Background Calls, each with a Notification that
 * wakes nobody and goes with the next input. Its Firing is for the Stop to end, or a later Run's end.
 */
export async function cancelStoppedCalls(
	config: () => Promise<OrqestraConfig>,
	conversationId: string,
	mcp?: McpAccess,
) {
	const top = (await rootOf(conversationId)) === conversationId;
	await cancel(
		config,
		conversationId,
		eq(backgroundCall.conversationId, conversationId),
		top
			? "The call was cancelled as the User stopped the Conversation: no result will come."
			: "The call was cancelled as the Subagent was stopped: no result will come.",
		async () => false,
		mcp,
	);
}

/** What `stopSubagents` cancels each stopped Subagent's Background Calls with (`runs.ts` cannot import this module). */
export const cancelStopped =
	(config: () => Promise<OrqestraConfig>, mcp?: McpAccess) => (id: string) =>
		cancelStoppedCalls(config, id, mcp);
