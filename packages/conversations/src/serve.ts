import type { Message } from "@earendil-works/pi-ai";
import {
	GENERAL_WORKER,
	modelRef,
	type OrqestraConfig,
	resolveTurn,
	type ThinkingLevel,
} from "@orqestra/config";
import { db, type Tx } from "@orqestra/db";
import {
	compaction,
	conversation,
	inbox,
	message,
	subagent,
} from "@orqestra/db/schema";
import { createPostgresBackend, Worker } from "bullmq";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
	AGENT_RUNS_QUEUE,
	type ConversationEvent,
	drain,
	type Ended,
	endRun,
	endSubagent,
	enqueue,
	ensureRun,
	lastModel,
	lockRoot,
	notify,
	STOP_CHANNEL,
	SUBAGENT_RUNS_QUEUE,
	stopSubagents,
	subagentOf,
} from "./runs.ts";

/** Tasks one start of Subagents may hand out. */
export const MAX_SUBAGENT_TASKS = 8;
/** Subagents an Agent may start or continue in all since the User's last message, so Notifications cannot keep it delegating forever. */
export const MAX_SUBAGENTS_PER_USER_MESSAGE = 16;

/** Starting or continuing these Subagents would spend more than the budget since the User's last message; `used` were already. */
export class BudgetExceeded extends Error {
	override name = "BudgetExceeded";
	constructor(
		readonly used: number,
		readonly max = MAX_SUBAGENTS_PER_USER_MESSAGE,
	) {
		super(`${used} of ${max} subagents used since the user's last message`);
	}
}
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
/** How a Subagent's Run ended, as its runtime judged it; a stop stands whatever is reported. */
export type Outcome = Ended;
/** Streaming events of the reply under way; the Conversation they belong to is the Run's. */
export type StreamEvent =
	| { type: "start" }
	| { type: "delta"; kind: "text" | "thinking"; index: number; delta: string };

/** One Run, as its handler sees it: what to reply to, and every way to save or show the reply. */
export type RunHandle = {
	conversationId: string;
	isSubagent: boolean;
	/** The Agent, Model and thinking level replying; a Subagent without instructions of its own gets the general worker's. */
	turn: Turn;
	transcript: Transcript;
	/** The User renamed the Conversation: it is not to be titled. */
	renamed: boolean;
	/** Aborts when the Run is stopped. */
	signal: AbortSignal;
	/** Inputs that arrived since, in order, now part of the transcript; empty when none did. */
	deliver(): Promise<Message[]>;
	/** Saves a finished or stopped reply (which ends its stream) or a Tool result; a failed reply is not saved but thrown. */
	save(message: Message): Promise<void>;
	stream(event: StreamEvent): Promise<void>;
	/** Saves a compaction: the model now sees `summary` and the messages from `firstKeptId` on. */
	compacted(
		summary: string,
		firstKeptId: number,
		tokensBefore: number,
	): Promise<void>;
	/**
	 * Ends the reply: returns the inputs that arrived meanwhile, to reply to next, or none, and the Run is over.
	 * A Subagent reports its `outcome`; a stopped Run is over whatever it reports.
	 */
	finish(outcome?: Outcome): Promise<Message[]>;
	/** Names the Conversation, unless the User renamed it meanwhile. */
	setTitle(title: string): Promise<void>;
	/** The Run's Subagents; only a top-level Conversation's Agent has them. */
	subagents: {
		/** Starts a Subagent per task, numbered in order; throws NoSuchTemplate, TemplateOffline or BudgetExceeded. */
		start(
			toolCallId: string,
			tasks: { brief: string; template?: string }[],
		): Promise<number[]>;
		/** Gives a Subagent more instructions, or continues it once finished; throws NoSuchSubagent or BudgetExceeded. */
		message(number: number, text: string): Promise<{ continued: boolean }>;
		/** Stops those of them still queued or running and returns their numbers; throws NoSuchSubagent. */
		stop(numbers: number[]): Promise<number[]>;
	};
};

export type ServeOptions = {
	/** Top-level Runs this worker works on at once. */
	concurrency?: number;
	/** Subagent Runs this worker works on at once. */
	subagentConcurrency?: number;
	/** How soon a crashed worker's Run is noticed; tests shorten it. */
	stalledInterval?: number;
};

/** Runs in this process, by Conversation id, so a stop request can abort them from the start (compaction included). */
const active = new Map<string, AbortController>();

/**
 * Under the parent's lock: spends `more` of the budget of Subagents started, or continued once finished, since the User's last message.
 * Throws, spending nothing, when it would run out.
 */
async function spend(tx: Tx, conversationId: string, more: number) {
	const [{ used }] = await tx
		.update(conversation)
		.set({
			subagentsSinceUser: sql`${conversation.subagentsSinceUser} + ${more}`,
		})
		.where(eq(conversation.id, conversationId))
		.returning({ used: conversation.subagentsSinceUser });
	if (used > MAX_SUBAGENTS_PER_USER_MESSAGE)
		throw new BudgetExceeded(used - more);
}

/**
 * Ends a stopped Run. Only the User stops a top-level one, which stops its Subagents too:
 * again after the Run ended, to catch any it started while the stop was on its way.
 */
async function stopped(
	conv: { id: string; parentId: string | null },
	result: string,
) {
	if (conv.parentId)
		return endSubagent(conv.id, { outcome: "stopped", result });
	await stopSubagents(conv.id);
	await endRun(conv.id, "idle");
}

/** A failed or crashed Run: a top-level Conversation is marked failed; a Subagent fails, and its Notification wakes the parent. */
async function failed(conversationId: string, error: Error) {
	const conv = await db.query.conversation.findFirst({
		where: eq(conversation.id, conversationId),
	});
	if (!conv) return;
	if (!conv.parentId) return endRun(conversationId, "failed");
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
	config: () => Promise<OrqestraConfig>,
	conversationId: string,
	handler: (run: RunHandle) => Promise<void>,
) {
	const conv = await db.query.conversation.findFirst({
		where: eq(conversation.id, conversationId),
	});
	if (!conv) return; // deleted while queued
	const stop = new AbortController();
	active.set(conversationId, stop);
	const sub = conv.parentId ? conversationId : undefined;
	// a Subagent's events go to its parent's page
	const emit = (event: ConversationEvent) =>
		notify(conv.parentId ?? conversationId, event);
	let over = false;
	try {
		if (sub) {
			const row = await db.query.subagent.findFirst({
				where: eq(subagent.conversationId, conversationId),
			});
			if (row?.outcome === "stopped") stop.abort(); // stopped while queued
		}
		const cfg = await config();
		const run = await open(cfg, conv, stop.signal, emit, () => {
			over = true;
		});
		await handler(run);
		if (!over && !stop.signal.aborted)
			throw new Error("The Run ended without finishing");
		if (!over) await stopped(conv, "");
	} catch (error) {
		// stopped before the reply was saved (while compacting, say): nothing to save
		if (stop.signal.aborted && !over) return stopped(conv, "");
		// the failed reply's live copy goes
		await emit({ type: "end", subagent: sub });
		throw error;
	} finally {
		// the next Run of this Conversation may have begun meanwhile, while this one titled it
		if (active.get(conversationId) === stop) active.delete(conversationId);
	}
}

async function open(
	cfg: OrqestraConfig,
	conv: typeof conversation.$inferSelect,
	signal: AbortSignal,
	emit: (event: ConversationEvent) => Promise<unknown>,
	end: () => void,
): Promise<RunHandle> {
	const conversationId = conv.id;
	const sub = conv.parentId ? conversationId : undefined;
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

	return {
		conversationId,
		isSubagent: !!sub,
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
		renamed: conv.titleEdited,
		signal,
		async deliver() {
			const messages = (await drain(conversationId)) as Message[];
			if (messages.length) await saved();
			return messages;
		},
		async save(m) {
			await db.insert(message).values({
				conversationId,
				message: m,
				model: modelRef(turn.model),
				thinkingLevel: turn.thinking,
			});
			await emit(
				m.role === "assistant"
					? { type: "end", subagent: sub }
					: { type: "saved" },
			);
		},
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
		async finish(outcome) {
			if (signal.aborted) {
				end();
				await stopped(conv, outcome?.result ?? "");
				return [];
			}
			const next = (await drain(
				conversationId,
				sub ? () => outcome ?? { outcome: "completed", result: "" } : true,
			)) as Message[];
			await saved();
			if (!next.length) end();
			return next;
		},
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
		subagents: subagentsOf(cfg, conv, turn, saved),
	};
}

/**
 * Each Subagent runs in a Conversation of its own, in the background and past the parent's Run, up to MAX_SUBAGENTS at once;
 * it hands back its result as a Notification that wakes the parent.
 */
function subagentsOf(
	cfg: OrqestraConfig,
	conv: typeof conversation.$inferSelect,
	parent: Turn,
	saved: () => Promise<unknown>,
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
		async start(toolCallId, tasks) {
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
				await spend(tx, parentId, picked.length);
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
					})),
				);
				await tx.insert(inbox).values(
					picked.map((t, i) => ({
						conversationId: children[i].id,
						message: { role: "user", content: t.brief, timestamp: Date.now() },
						model: modelRef(t.model),
						thinkingLevel: t.thinking,
						wake: true,
					})),
				);
				return { first, children };
			});
			// beyond MAX_SUBAGENTS they stay queued until one finishes
			for (const c of children) await ensureRun(c.id);
			await saved();
			return children.map((_, i) => first + i);
		},

		async message(number, text) {
			const row = await db.transaction(async (tx) => {
				await lockRoot(tx, parentId);
				const row = await find(tx, number);
				const continued = !["queued", "running"].includes(row.outcome);
				if (continued) {
					await spend(tx, parentId, 1);
					// it waits for a slot like a new one, and a stop catches it while it waits
					await tx
						.update(subagent)
						.set({ outcome: "queued" })
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
			return stopSubagents(parentId, numbers);
		},
	};
}

/**
 * Starts the BullMQ workers for top-level and Subagent Runs plus the listener for stop requests, after queueing again
 * the Runs a crash left without a job; resolves to a close function. `handler` produces each Run's reply.
 */
export async function serveRuns(
	config: () => Promise<OrqestraConfig>,
	handler: (run: RunHandle) => Promise<void>,
	{
		concurrency = 8,
		subagentConcurrency = 8,
		stalledInterval = 30_000,
	}: ServeOptions = {},
) {
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
			(job) => execute(config, job.data.conversationId, handler),
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
				void failed(job.data.conversationId, err).catch((error) =>
					console.error(`could not mark job ${job.id}'s Run failed`, error),
				);
		});
		worker.on("error", (err) => console.error("worker error", err));
		return worker;
	});
	// the pg backend doesn't emit 'error' on connect failure, so fail fast instead of idling silently
	await Promise.all(workers.map((w) => w.waitUntilReady()));
	await requeue();

	return async () => {
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
