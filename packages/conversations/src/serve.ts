import type { Message } from "@earendil-works/pi-ai";
import { GENERAL_WORKER, resolveTurn } from "@orqestra/agents";
import { db, type Tx } from "@orqestra/db";
import {
	attachment,
	compaction,
	conversation,
	firing,
	inbox,
	message,
	subagent,
	type UsagePurpose,
	usage,
} from "@orqestra/db/schema";
import type {
	BackgroundCallStart,
	ConnectionStore,
	McpAccess,
} from "@orqestra/mcp";
import { type Memories, memoriesOf, memoryOn } from "@orqestra/memory";
import {
	modelRef,
	type StreamSimple,
	type ThinkingLevel,
} from "@orqestra/models";
import type { SkillFile } from "@orqestra/skills/shared";
import type { ObjectStore, Orrery, SandboxProvider } from "@orqestra/tools";
import { createPostgresBackend, Worker } from "bullmq";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { alertRun } from "./alerts.ts";
import {
	BACKGROUND_CALLS_QUEUE,
	cancelStopped,
	cancelStoppedCalls,
	pollBackgroundCall,
	requeueBackgroundCalls,
	startBackgroundCall,
} from "./background-calls.ts";
import { metered, providerLimiter } from "./metered.ts";
import { type Recall, recallOf } from "./recall.ts";
import {
	AGENT_RUNS_QUEUE,
	type ConversationEvent,
	drain,
	type Ended,
	endRun,
	endSubagent,
	enqueue,
	ensureRun,
	FIRINGS_QUEUE,
	lastModel,
	lockRoot,
	notify,
	STOP_CHANNEL,
	SUBAGENT_RUNS_QUEUE,
	spend,
	stopSubagents,
	subagentOf,
} from "./runs.ts";
import { ensureSandbox } from "./sandbox.ts";
import type { Snapshots } from "./snapshots.ts";
import { SpendingLimitReached, spendingLimitStatus } from "./spending.ts";
import { fire } from "./tasks.ts";
import { cancelTimer, ring, setTimer, TIMERS_QUEUE } from "./timers.ts";
import { storeAttachment, sweepUnsentAttachments } from "./uploads.ts";

/** Tasks one start of Subagents may hand out. */
export const MAX_SUBAGENT_TASKS = 8;
export class NoSuchSubagent extends Error {
	override name = "NoSuchSubagent";
	constructor(readonly number: number) {
		super(`There is no subagent ${number}`);
	}
}
export class NoSuchTemplate extends Error {
	override name = "NoSuchTemplate";
	constructor(readonly template: string) {
		super(`There is no template "${template}"`);
	}
}
/** The template has no Model left to run on. */
export class TemplateOffline extends Error {
	override name = "TemplateOffline";
	constructor(readonly template: string) {
		super(`Template "${template}" has no available Model`);
	}
}

/** The reason an Unattended Run's signal aborts with once it has run past the Limits' wall-clock time: a stop, but not the User's. */
export class RunTimedOut extends Error {
	override name = "RunTimedOut";
	constructor(readonly seconds: number) {
		super(`The unattended Run ran past its ${seconds}-second limit`);
	}
}

export type Turn = NonNullable<ReturnType<typeof resolveTurn>>;
export type TranscriptMessage = {
	id: number;
	message: Message;
	createdAt: Date;
};
/** A Conversation's messages up to the Run's first inputs, and its latest compaction. */
export type Transcript = {
	messages: TranscriptMessage[];
	compaction?: { summary: string; firstKeptId: number; createdAt: Date };
};
/** Streaming events of the reply under way; the Conversation they belong to is the Run's. */
export type StreamEvent =
	| { type: "start" }
	| { type: "delta"; kind: "text" | "thinking"; index: number; delta: string };

/** A span's W3C trace context (`traceparent`), as the worker's tracer injects it, kept so a Run in another job can continue or link to it. */
export type TraceCarrier = Record<string, string>;

/** One Run, as its handler sees it: what to reply to, and every way to save or show the reply. */
export type RunHandle = {
	conversationId: string;
	/** The Polaris `sub` of the Conversation's User. */
	userId: string;
	/** The top-level Conversation: the Run's own for a top-level Run. */
	rootConversationId: string;
	/** The Scheduled Task whose Firing started the top-level Conversation, and that Firing; none otherwise. */
	scheduledTaskId?: string;
	firingId?: number;
	/**
	 * Where the Run's span goes: a Subagent's first Run under `parent`, the Tool call that started it; any other Run a root of its own,
	 * linked to the Tool calls that set going the work whose inputs woke it (a Subagent continued, a Notification). None for a User's message.
	 */
	trace: { parent?: TraceCarrier; links: TraceCarrier[] };
	isSubagent: boolean;
	/**
	 * Nobody is watching: an Unattended Run, under the Limits' step cap; past their wall-clock time its signal aborts with RunTimedOut.
	 * Judged as the Run starts, from its top-level Conversation.
	 */
	unattended: boolean;
	/** The Agent, Model and thinking level replying; a Subagent without instructions of its own gets the general worker's. */
	turn: Turn;
	transcript: Transcript;
	/** The Conversation has a title, generated or the User's: it is not to be titled again. */
	titled: boolean;
	/** Aborts when the Run is stopped, with RunTimedOut when an Unattended Run ran out of time. */
	signal: AbortSignal;
	/** Inputs that arrived since, in order, now part of the transcript; empty when none did. */
	deliver(): Promise<Message[]>;
	/** Saves a finished or stopped reply (which ends its stream) or a Tool result; a failed reply is not saved but thrown. */
	save(message: Message): Promise<void>;
	/**
	 * Keeps a file the Agent attaches as an Attachment of the Conversation, a snapshot in object storage under a free name, which it returns
	 * with its size; throws UploadTooLarge past MAX_UPLOAD_BYTES. The `attach` Tool result naming it ties it to that message once saved.
	 */
	attach(
		name: string,
		body: ReadableStream<Uint8Array>,
	): Promise<{ name: string; size: number }>;
	stream(event: StreamEvent): Promise<void>;
	/** Saves a compaction: the model now sees `summary` and the messages from `firstKeptId` on. */
	compacted(
		summary: string,
		firstKeptId: number,
		tokensBefore: number,
	): Promise<void>;
	/**
	 * Ends the reply: returns the inputs that arrived meanwhile, to reply to next, or none, and the Run is over.
	 * A Subagent reports its `outcome`, and so does an Unattended Run; a stopped Run is over whatever it reports, a timed-out Subagent ending partial.
	 * A reply that asked the User a `question` waits for them: only a message of theirs goes on, Notifications wait with it.
	 */
	finish(outcome?: Ended, options?: { question?: boolean }): Promise<Message[]>;
	/**
	 * The Run's Model requests for `purpose`, each with the Provider's configured key: first checked against the User's
	 * Spending Limit as it stands then, throwing SpendingLimitReached unsent once it is used up, then recorded as Usage once
	 * its stream ends, whatever the end (see `metered`). The only way the Run reaches a Model.
	 */
	streamSimple(purpose: UsagePurpose): StreamSimple;
	/** Names the Conversation, unless the User renamed it meanwhile. */
	setTitle(title: string): Promise<void>;
	/**
	 * The Conversation's Sandbox, ready to use, with the Sandbox Provider's client that reaches it: created the first time,
	 * started if stopped (`woke`); see `ensureSandbox`. Throws when no Sandbox Provider is configured.
	 */
	sandbox(): Promise<{ id: string; woke: boolean; client: Orrery }>;
	/** A Skill version's files, to write into the Sandbox. */
	skillFiles(versionId: number): Promise<SkillFile[]>;
	/** Object storage, where the Attachments are kept; Parse reads them there. */
	store: ObjectStore;
	/** The Users' Connections, which per-User OAuth MCP Servers are signed in to with; without them, those servers are left out. */
	connections?: ConnectionStore;
	/** The Attachment `name` of the Conversation, else of the nearest Conversation above it up to the top-level one, with its object storage key; undefined when there is none. */
	attachment(name: string): Promise<{ key: string } | undefined>;
	/** The Memories of the Conversation's User; writes record this Conversation. None while the User has memory off or the Conversation is Incognito, and no Recall then either. */
	memories?: Memories;
	/** The User's past Conversations, for Recall. */
	recall: Recall;
	/** The Conversation's Timer; only a top-level Conversation's Agent has one. */
	timer?: {
		/**
		 * Sets it, replacing the one set before, to ring `delay` seconds from now with `note`; returns when it rings.
		 * Throws TimerDelayOutOfRange, or TimerLimitReached once Timers rang the Limits' times since the User's last message.
		 */
		set(delay: number, note: string): Promise<Date>;
		/** True when there was one to cancel. */
		cancel(): Promise<boolean>;
	};
	/** The Run's Background Calls: Tool calls its MCP Servers put in the background, tracked past the Run until they end. */
	backgroundCalls?: {
		/**
		 * Starts tracking one; its outcome comes as a Notification. Returns its id.
		 * `trace`: the trace context of the Tool call's span, which the Run its Notification wakes links to.
		 */
		start(call: BackgroundCallStart, trace?: TraceCarrier): Promise<string>;
	};
	/** The Run's Subagents; none for a Subagent at the deepest level Subagents may nest to. */
	subagents?: {
		/**
		 * Starts a Subagent per task, numbered in order; throws NoSuchTemplate, TemplateOffline or BudgetExceeded.
		 * `trace`: the trace context of the Tool call's span, which the Subagent's first Run goes under and its Notification links to.
		 */
		start(
			toolCallId: string,
			tasks: { brief: string; template?: string }[],
			trace?: TraceCarrier,
		): Promise<number[]>;
		/** Gives a Subagent more instructions, or continues it once finished; throws NoSuchSubagent or BudgetExceeded. `trace`: the Tool call's, as for `start`. */
		message(
			number: number,
			text: string,
			trace?: TraceCarrier,
		): Promise<{ continued: boolean }>;
		/** Stops those of them still queued or running and returns their numbers; throws NoSuchSubagent. */
		stop(numbers: number[]): Promise<number[]>;
	};
};

/** The config a Run's Turn was resolved from, without its Models' unmetered streaming: the Run reaches them through `run.streamSimple`. */
export type RunConfig = Omit<Snapshots, "streamSimple" | "registry">;

/** Replies to one Run; gets the config the Run's Turn was resolved from. */
export type RunHandler = (run: RunHandle, config: RunConfig) => Promise<void>;

export type ServeOptions = {
	/** Top-level Runs this worker works on at once. */
	concurrency?: number;
	/** Subagent Runs this worker works on at once. */
	subagentConcurrency?: number;
	/** Model requests to one Provider at once, across this worker's Runs. */
	providerConcurrency?: number;
	/** How soon a crashed worker's Run is noticed; tests shorten it. */
	stalledInterval?: number;
};

/** What Runs are served with, given once to `createConversations`. */
export type RunDeps = {
	/** Read as each Run starts: a Run keeps the config it started with. */
	config: () => Promise<Snapshots>;
	store: ObjectStore;
	/** The Sandbox Provider's client. */
	orrery: (provider: SandboxProvider) => Orrery;
	skillFiles: (versionId: number) => Promise<SkillFile[]>;
	/** What Background Calls are polled and cancelled with. */
	mcp: McpAccess;
};

/** Runs in this process, by Conversation id, so a stop request can abort them from the start (compaction included). */
const active = new Map<string, AbortController>();

/**
 * Ends a stopped Run, which stops the Subagents under it too:
 * again after the Run ended, to catch any it started while the stop was on its way.
 */
async function stopped(
	conv: { id: string; parentId: string | null },
	result: string,
	signal: AbortSignal,
	config: () => Promise<Snapshots>,
	mcp?: McpAccess,
) {
	await stopSubagents(conv.id, cancelStopped(config, mcp));
	// out of time is no stop of the User's: the parent gets what it has, the User an Alert
	const timedOut = signal.reason instanceof RunTimedOut;
	// one handed off while the stop was on its way: Stop cancels it too
	if (!timedOut) await cancelStoppedCalls(config, conv.id, mcp);
	if (conv.parentId)
		return endSubagent(conv.id, {
			outcome: timedOut ? "partial" : "stopped",
			result,
		});
	await endRun(conv.id, "idle", undefined, !timedOut);
	if (timedOut) await alertRun(conv.id, "partial");
}

/** A failed or crashed Run: a top-level Conversation is marked failed; a Subagent fails, and its Notification wakes the parent. */
async function failed(
	conversationId: string,
	error: Error,
	config: () => Promise<Snapshots>,
	mcp?: McpAccess,
) {
	const conv = await db.query.conversation.findFirst({
		where: eq(conversation.id, conversationId),
	});
	if (!conv) return;
	if (!conv.parentId) {
		// one Alert: a failure that auto-paused the Firing's task says so
		const paused = await endRun(
			conversationId,
			"failed",
			error instanceof SpendingLimitReached ? "spending_limit" : "error",
		);
		return alertRun(conversationId, paused ? "auto_paused" : "failed");
	}
	// the Subagents under it would report to nobody
	await stopSubagents(conversationId, cancelStopped(config, mcp));
	await endSubagent(conversationId, {
		outcome: "failed",
		result: `[The subagent failed, or the worker running it crashed: ${error.message}]`,
	});
}

/**
 * One Run of a Conversation: delivers its first inputs, then hands the Run to `handler` until it has finished.
 * A stopped Run ends here; a failed one is ended by the worker's 'failed' handler, which also sees crashes.
 */
async function execute(
	deps: RunDeps & { limit: (streamSimple: StreamSimple) => StreamSimple },
	conversationId: string,
	jobId: string | undefined,
	handler: RunHandler,
) {
	const { config, mcp } = deps;
	// listening for a Stop before reading the row, which holds one sent before this listened
	const stop = new AbortController();
	active.set(conversationId, stop);
	const conv = await db.query.conversation.findFirst({
		where: eq(conversation.id, conversationId),
	});
	if (!conv) {
		active.delete(conversationId);
		return; // deleted while queued
	}
	if (jobId && conv.stoppedJobId === jobId) stop.abort();
	const sub = conv.parentId ? conversationId : undefined;
	// a Subagent's events go to its root's page
	const emit = (event: ConversationEvent) => notify(conv.rootId, event);
	let over = false;
	let clock: ReturnType<typeof setTimeout> | undefined;
	try {
		if (sub) {
			const row = await db.query.subagent.findFirst({
				where: eq(subagent.conversationId, conversationId),
			});
			if (row?.outcome === "stopped") stop.abort(); // stopped while queued
		}
		const cfg = await config();
		// a Subagent goes by its root
		const root = conv.parentId
			? await db.query.conversation.findFirst({
					where: eq(conversation.id, conv.rootId),
				})
			: conv;
		const unattended = !!root?.unattended;
		const rootFiring =
			root?.scheduledTaskId &&
			(await db.query.firing.findFirst({
				where: eq(firing.conversationId, root.id),
				columns: { id: true },
			}));
		if (unattended) {
			const seconds = cfg.limits.unattendedMaxDuration;
			clock = setTimeout(
				() => stop.abort(new RunTimedOut(seconds)),
				seconds * 1000,
			);
		}
		const run = await open(
			deps,
			cfg,
			conv,
			{
				incognito: !!root?.incognito,
				unattended,
				scheduledTaskId: root?.scheduledTaskId ?? null,
				firingId: rootFiring ? rootFiring.id : undefined,
			},
			stop.signal,
			emit,
			() => {
				over = true;
			},
		);
		await handler(run, cfg);
		if (!over && !stop.signal.aborted)
			throw new Error("The Run ended without finishing");
		if (!over) await stopped(conv, "", stop.signal, config, mcp);
	} catch (error) {
		// stopped before the reply was saved (while compacting, say): nothing to save
		if (stop.signal.aborted && !over)
			return stopped(conv, "", stop.signal, config, mcp);
		// the failed reply's live copy goes
		await emit({ type: "end", subagent: sub });
		throw error;
	} finally {
		clearTimeout(clock);
		// the next Run of this Conversation may have begun meanwhile, while this one titled it
		if (active.get(conversationId) === stop) active.delete(conversationId);
	}
}

async function open(
	{
		store,
		orrery,
		skillFiles,
		mcp,
		limit,
	}: RunDeps & { limit: (streamSimple: StreamSimple) => StreamSimple },
	cfg: Snapshots,
	conv: typeof conversation.$inferSelect,
	root: {
		incognito: boolean;
		unattended: boolean;
		scheduledTaskId: string | null;
		firingId?: number;
	},
	signal: AbortSignal,
	emit: (event: ConversationEvent) => Promise<unknown>,
	end: () => void,
): Promise<RunHandle> {
	const conversationId = conv.id;
	const sub = conv.parentId ? conversationId : undefined;
	// the trace context of the inputs about to wake it; one arriving in between just goes unlinked
	const traces = (
		await db
			.select({ trace: inbox.trace })
			.from(inbox)
			.where(eq(inbox.conversationId, conversationId))
	).flatMap((r) => (r.trace ? [r.trace] : []));
	// nothing to reload: the inputs showed already, from the inbox
	await drain(conversationId);
	const rows = await db
		.select({
			id: message.id,
			message: message.message,
			model: message.model,
			thinkingLevel: message.thinkingLevel,
			createdAt: message.createdAt,
		})
		.from(message)
		.where(eq(message.conversationId, conversationId))
		.orderBy(asc(message.id));
	const last = rows.at(-1);
	if ((last?.message as Message | undefined)?.role !== "user" || !last)
		throw new Error("Nothing to reply to");
	const picked = resolveTurn(cfg, conv.agentId, {
		model: last.model,
		thinking: last.thinkingLevel as ThinkingLevel,
	});
	if (!picked)
		throw new Error(`Agent "${conv.agentId}" is no longer configured`);
	const turn: Turn = sub
		? {
				...picked,
				agent: {
					...picked.agent,
					instructions: picked.agent.instructions || GENERAL_WORKER,
				},
			}
		: picked;
	const previous = await db.query.compaction.findFirst({
		where: eq(compaction.conversationId, conversationId),
		orderBy: desc(compaction.id),
	});
	const saved = () => emit({ type: "saved" });
	const { incognito, unattended } = root;

	return {
		conversationId,
		userId: conv.userId,
		rootConversationId: conv.rootId,
		scheduledTaskId: root.scheduledTaskId ?? undefined,
		firingId: root.firingId,
		trace: {
			parent: traces.find((t) => t.parent)?.parent,
			links: traces.flatMap((t) => (t.link ? [t.link] : [])),
		},
		isSubagent: !!sub,
		unattended,
		turn,
		transcript: {
			messages: rows.map((r) => ({
				id: r.id,
				message: r.message as Message,
				createdAt: r.createdAt,
			})),
			compaction: previous && {
				summary: previous.summary,
				firstKeptId: previous.firstKeptMessageId,
				createdAt: previous.createdAt,
			},
		},
		titled: conv.title !== null || conv.titleEdited,
		signal,
		async deliver() {
			const messages = (await drain(conversationId)) as Message[];
			if (messages.length) await saved();
			return messages;
		},
		async save(m) {
			const [row] = await db
				.insert(message)
				.values({
					conversationId,
					message: m,
					model: modelRef(turn.model),
					thinkingLevel: turn.thinking,
				})
				.returning({ id: message.id });
			const attached =
				m.role === "toolResult" && m.toolName === "attach" && !m.isError
					? (m.details as { attachment?: { name: string } } | undefined)
							?.attachment
					: undefined;
			// a retry withdrawing this message deletes the Attachment with it; one never tied is unsent, and swept
			if (attached)
				await db
					.update(attachment)
					.set({ messageId: row.id, sent: true })
					.where(
						and(
							eq(attachment.conversationId, conversationId),
							eq(attachment.name, attached.name),
							isNull(attachment.messageId),
						),
					);
			await emit(
				m.role === "assistant"
					? { type: "end", subagent: sub }
					: { type: "saved" },
			);
		},
		attach: (name, body) =>
			storeAttachment(store, conv, name, body, { signal }),
		async stream(event) {
			await emit({ ...event, subagent: sub });
		},
		async compacted(summary, firstKeptId, tokensBefore) {
			await db.insert(compaction).values({
				conversationId,
				summary,
				firstKeptMessageId: firstKeptId,
				tokensBefore,
			});
			await saved();
		},
		async finish(outcome, { question = false } = {}) {
			if (signal.aborted) {
				end();
				await stopped(
					conv,
					outcome?.result ?? "",
					signal,
					async () => cfg,
					mcp,
				);
				return [];
			}
			// an Unattended Run cut off at its step cap ends partial
			const status = question
				? "question"
				: outcome?.outcome === "partial"
					? "partial"
					: "completed";
			const next = (await drain(
				conversationId,
				sub
					? () => outcome ?? { outcome: "completed", result: "" }
					: status === "completed"
						? true
						: status,
			)) as Message[];
			await saved();
			if (!next.length) {
				end();
				if (!sub) await alertRun(conversationId, status);
			}
			return next;
		},
		streamSimple: metered(limit(cfg.streamSimple), {
			reached: async () => !!(await spendingLimitStatus(conv.userId))?.reached,
			record: (counted) =>
				db.insert(usage).values({
					userId: conv.userId,
					// the general worker is no Agent Definition
					agentId: conv.agentId,
					agentName: conv.agentId === null ? null : turn.agent.name,
					conversationId: conv.rootId,
					scheduledTaskId: root.scheduledTaskId,
					...counted,
				}),
		}),
		async setTitle(title) {
			await db
				.update(conversation)
				.set({ title })
				// a rename that landed meanwhile wins
				.where(
					and(
						eq(conversation.id, conversationId),
						eq(conversation.titleEdited, false),
					),
				);
			await saved();
		},
		async sandbox() {
			const provider = cfg.sandboxProvider;
			if (!provider) throw new Error("No Sandbox Provider is configured");
			const client = orrery(provider);
			return {
				...(await ensureSandbox(conversationId, client, provider, { signal })),
				client,
			};
		},
		skillFiles,
		store,
		connections: mcp.connections,
		async attachment(name) {
			// this Conversation's, else the nearest ancestor's, up to the top-level Conversation (same User throughout)
			const { rows } = await db.execute<{ key: string }>(
				sql`with recursive up as (
					select id, parent_id, depth from conversation where id = ${conversationId}
					union all
					select c.id, c.parent_id, c.depth from conversation c join up on c.id = up.parent_id
				)
				select a.key from up join attachment a on a.conversation_id = up.id
				where a.name = ${name}
				order by up.depth desc limit 1`,
			);
			return rows[0] && { key: rows[0].key };
		},
		// an Incognito Conversation's Runs, its Subagents' too, have no memory
		memories:
			!incognito && (await memoryOn(conv.userId))
				? memoriesOf(conv.userId, conversationId)
				: undefined,
		// a Subagent works within its parent's Conversation, so that is not a past one either
		recall: recallOf(conv.userId, conv.rootId),
		timer: sub
			? undefined
			: {
					set: (delay, note) =>
						setTimer(conversationId, {
							delay,
							note,
							model: modelRef(turn.model),
							thinkingLevel: turn.thinking,
							maxRings: cfg.limits.timerRingsPerUserMessage,
						}),
					cancel: () => cancelTimer(conversationId),
				},
		backgroundCalls: {
			start: (call, trace) => startBackgroundCall(conversationId, call, trace),
		},
		subagents:
			conv.depth < cfg.limits.maxSubagentDepth
				? subagentsOf(cfg, conv, turn, saved, mcp)
				: undefined,
	};
}

/**
 * Each Subagent runs in a Conversation of its own, in the background and past the parent's Run, up to MAX_SUBAGENTS of the tree at once;
 * it hands back its result as a Notification that wakes the parent.
 */
function subagentsOf(
	cfg: Snapshots,
	conv: typeof conversation.$inferSelect,
	parent: Turn,
	saved: () => Promise<unknown>,
	mcp?: McpAccess,
): RunHandle["subagents"] {
	const parentId = conv.id;
	const find = async (tx: Tx, number: number) => {
		const row = await tx.query.subagent.findFirst({
			where: and(subagentOf(parentId), eq(subagent.number, number)),
		});
		if (!row) throw new NoSuchSubagent(number);
		return row;
	};
	return {
		async start(toolCallId, tasks, trace) {
			const picked = tasks.map((t) => {
				const template = cfg.agents.find((a) => a.id === t.template);
				if (t.template && !template) throw new NoSuchTemplate(t.template);
				if (template && !template.allModels && !template.models.length)
					throw new TemplateOffline(template.id);
				// a template with its own Models runs on its default; otherwise the Subagent inherits the parent's
				const own =
					template && !template.allModels && resolveTurn(cfg, template.id);
				return {
					brief: t.brief,
					template,
					model: own ? own.model : parent.model,
					thinking: own ? own.thinking : parent.thinking,
				};
			});
			const { first, children } = await db.transaction(async (tx) => {
				await lockRoot(tx, parentId);
				await spend(tx, conv.rootId, picked.length);
				const [{ numbered }] = await tx
					.select({
						numbered: sql<number>`coalesce(max(${subagent.number}), 0)`,
					})
					.from(subagent)
					.where(subagentOf(parentId));
				const first = Number(numbered) + 1;
				const children = await tx
					.insert(conversation)
					.values(
						picked.map((t) => ({
							userId: conv.userId,
							parentId,
							agentId: t.template?.id ?? null,
						})),
					)
					.returning({ id: conversation.id });
				await tx.insert(subagent).values(
					picked.map((t, i) => ({
						conversationId: children[i].id,
						toolCallId,
						number: first + i,
						brief: t.brief,
						trace,
					})),
				);
				await tx.insert(inbox).values(
					picked.map((t, i) => ({
						conversationId: children[i].id,
						message: { role: "user", content: t.brief, timestamp: Date.now() },
						model: modelRef(t.model),
						thinkingLevel: t.thinking,
						wake: true,
						trace: trace && { parent: trace },
					})),
				);
				return { first, children };
			});
			// beyond MAX_SUBAGENTS they stay queued until one finishes
			for (const c of children) await ensureRun(c.id);
			await saved();
			return children.map((_, i) => first + i);
		},

		async message(number, text, trace) {
			const row = await db.transaction(async (tx) => {
				await lockRoot(tx, parentId);
				const row = await find(tx, number);
				const continued = !["queued", "running"].includes(row.outcome);
				if (continued) {
					await spend(tx, conv.rootId, 1);
					// it waits for a slot like a new one, and a stop catches it while it waits; its Notification now links to this call
					await tx
						.update(subagent)
						.set({ outcome: "queued", trace })
						.where(eq(subagent.conversationId, row.conversationId));
				}
				// it continues on the Model it last used
				const last = await lastModel(tx, row.conversationId);
				await tx.insert(inbox).values({
					conversationId: row.conversationId,
					message: { role: "user", content: text, timestamp: Date.now() },
					model: last?.model ?? modelRef(parent.model),
					thinkingLevel: last?.thinkingLevel ?? parent.thinking,
					wake: true,
					// a running one reads it in the Run it is in
					trace: continued && trace ? { link: trace } : undefined,
				});
				return { ...row, continued };
			});
			await ensureRun(row.conversationId);
			await saved();
			return { continued: row.continued };
		},

		async stop(numbers) {
			await db.transaction(async (tx) => {
				for (const n of numbers) await find(tx, n);
			});
			return stopSubagents(
				parentId,
				cancelStopped(async () => cfg, mcp),
				numbers,
			);
		},
	};
}

/**
 * Starts the BullMQ workers for top-level and Subagent Runs plus the listener for stop requests, after queueing again
 * the Runs a crash left without a job; resolves to a close function. `handler` produces each Run's reply.
 */
export async function serveRuns(
	deps: RunDeps,
	handler: RunHandler,
	{
		concurrency = 8,
		subagentConcurrency = 8,
		providerConcurrency = 8,
		stalledInterval = 30_000,
	}: ServeOptions = {},
) {
	const { config, store, mcp } = deps;
	// one Provider's limit holds across this worker's Runs and configs
	const limited = { ...deps, limit: providerLimiter(providerConcurrency) };
	const databaseUrl = process.env.DATABASE_URL as string;
	// a pool connection held for good, since LISTEN is per connection
	const listener = await db.$client.connect();
	await listener.query(`LISTEN ${STOP_CHANNEL}`);
	listener.on("notification", (n) => active.get(n.payload ?? "")?.abort());

	const workers = (
		[
			[AGENT_RUNS_QUEUE, concurrency],
			[SUBAGENT_RUNS_QUEUE, subagentConcurrency],
		] as const
	).map(([queue, concurrency]) => {
		const worker = new Worker(
			queue,
			(job) => execute(limited, job.data.conversationId, job.id, handler),
			{
				concurrency,
				// bullmq tables live in their own "bullmq" schema; migrate is advisory-locked across processes
				connection: { connectionString: databaseUrl, migrate: true },
				// a run lost to a crashed worker fails instead of re-running; the UI offers a retry.
				// The pg backend requeues a stalled job with a deferred failure, which a worker then emits as 'failed' below
				maxStalledCount: 0,
				stalledInterval,
			},
			createPostgresBackend,
		);
		worker.on("failed", (job, err) => {
			console.error(`job ${job?.id} failed`, err);
			if (job)
				void failed(job.data.conversationId, err, config, mcp).catch((error) =>
					console.error(`could not mark job ${job.id}'s Run failed`, error),
				);
		});
		worker.on("error", (err) => console.error("worker error", err));
		return worker;
	});
	const timers = new Worker(
		TIMERS_QUEUE,
		(job) => ring(job.data.conversationId, job.data.ringsAt),
		{ connection: { connectionString: databaseUrl, migrate: true } },
		createPostgresBackend,
	);
	timers.on("failed", (job, err) =>
		console.error(`Timer job ${job?.id} failed`, err),
	);
	timers.on("error", (err) => console.error("worker error", err));
	// a Firing only starts a Conversation, whose Run goes to agent-runs
	const firings = new Worker(
		FIRINGS_QUEUE,
		(job) => fire(config, job.data.taskId, job.id as string),
		{ connection: { connectionString: databaseUrl, migrate: true } },
		createPostgresBackend,
	);
	firings.on("failed", (job, err) =>
		console.error(`Firing job ${job?.id} failed`, err),
	);
	firings.on("error", (err) => console.error("worker error", err));
	// polls hold no Run, Timer or Subagent slot
	const polls = new Worker(
		BACKGROUND_CALLS_QUEUE,
		(job) =>
			pollBackgroundCall(
				config,
				job.data.backgroundCallId,
				job.id as string,
				mcp,
			),
		{
			connection: { connectionString: databaseUrl, migrate: true },
			concurrency: 8,
		},
		createPostgresBackend,
	);
	polls.on("failed", (job, err) =>
		console.error(`Background Call job ${job?.id} failed`, err),
	);
	polls.on("error", (err) => console.error("worker error", err));
	workers.push(timers, firings, polls);
	// the pg backend doesn't emit 'error' on connect failure, so fail fast instead of idling silently
	await Promise.all(workers.map((w) => w.waitUntilReady()));
	await requeue();
	await requeueBackgroundCalls();
	// every worker sweeps; a row is deleted, with its object, by whichever gets it first
	const sweep = setInterval(
		() =>
			sweepUnsentAttachments(store).catch((error) =>
				console.error("could not sweep unsent Attachments", error),
			),
		3600_000,
	);

	return async () => {
		clearInterval(sweep);
		await Promise.all(workers.map((w) => w.close()));
		listener.release(true); // destroy rather than return a LISTENing connection to the pool
	};
}

/**
 * Queues again the Runs left running without a job, lost to a crash between saving a Run's start and queueing it.
 * Each is queued as the job its start saved, so a Run that has its job, or that its start is queueing right now, gets no second one.
 */
async function requeue() {
	const running = await db
		.select({ id: conversation.id })
		.from(conversation)
		.where(eq(conversation.status, "running"));
	for (const c of running) await enqueue(c.id);
}
