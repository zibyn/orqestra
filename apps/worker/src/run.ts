import {
	Agent,
	type AgentMessage,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	shouldCompact,
} from "@earendil-works/pi-coding-agent";
import {
	GENERAL_WORKER,
	messageText,
	modelRef,
	type OrqestraConfig,
	resolveTurn,
	type ThinkingLevel,
} from "@orqestra/config";
import {
	AGENT_RUNS_QUEUE,
	and,
	asc,
	type ConversationEvent,
	conversationChannel,
	db,
	desc,
	eq,
	STOP_CHANNEL,
	SUBAGENT_RUNS_QUEUE,
	sql,
} from "@orqestra/db";
import { drain, endSubagent, enqueue, runQueue } from "@orqestra/db/runs";
import {
	compaction,
	conversation,
	message,
	subagent,
} from "@orqestra/db/schema";
import { createPostgresBackend, Worker } from "bullmq";
import {
	limiter,
	MAX_SUBAGENT_STEPS,
	relay,
	STEP_LIMIT,
	searchTools,
	subagentTools,
} from "./tools.ts";

type Turn = NonNullable<ReturnType<typeof resolveTurn>>;
type Row = typeof message.$inferSelect & { message: Message };
type Conv = typeof conversation.$inferSelect;

/** Runs in this process, by Conversation id, so a stop request can abort them from the start (compaction included). */
const active = new Map<string, AbortController>();

// a Subagent's events go to its parent's channel, where the UI shows it
const notify = (conversationId: string, event: ConversationEvent) =>
	db.execute(
		sql`select pg_notify(${conversationChannel(conversationId)}, ${JSON.stringify(event)})`,
	);

async function setStatus(conv: Conv, status: Conv["status"]) {
	await db
		.update(conversation)
		.set({ status })
		.where(eq(conversation.id, conv.id));
	await notify(conv.parentId ?? conv.id, { type: "saved" });
}

/** Delivers the inbox and replies, until the inbox stays empty. */
export async function runTurn(conversationId: string, config: OrqestraConfig) {
	const conv = await db.query.conversation.findFirst({
		where: eq(conversation.id, conversationId),
	});
	if (!conv) return; // deleted while queued
	const stop = new AbortController();
	active.set(conversationId, stop);
	if (conv.parentId) {
		const row = await db.query.subagent.findFirst({
			where: eq(subagent.conversationId, conversationId),
		});
		if (row?.outcome === "stopped") stop.abort(); // stopped while queued
	}
	try {
		await reply(conv, config, stop.signal);
	} catch (error) {
		// stopped while compacting: nothing to save
		if (stop.signal.aborted) {
			if (conv.parentId)
				return endSubagent(conversationId, { outcome: "stopped", result: "" });
			return setStatus(conv, "idle");
		}
		// a Subagent's is settled by the worker's 'failed' handler, which also sees crashes
		if (!conv.parentId) await setStatus(conv, "failed");
		throw error;
	} finally {
		active.delete(conversationId);
	}
}

async function reply(conv: Conv, config: OrqestraConfig, signal: AbortSignal) {
	const conversationId = conv.id;
	const sub = conv.parentId ? conversationId : undefined;
	const send = (event: ConversationEvent) =>
		notify(conv.parentId ?? conversationId, event);
	// nothing to reload: the inputs showed already, from the inbox
	await drain(conversationId);
	const rows = (await db
		.select()
		.from(message)
		.where(eq(message.conversationId, conversationId))
		.orderBy(asc(message.id))) as Row[];
	const last = rows.at(-1);
	if (last?.message.role !== "user") throw new Error("Nothing to reply to");
	const turn = resolveTurn(config, conv.agentId, {
		model: last.model,
		thinking: last.thinkingLevel as ThinkingLevel,
	});
	if (!turn) throw new Error(`Agent "${conv.agentId}" is no longer configured`);
	const streamFn: StreamFn = config.streamSimple;
	const tools = searchTools(config, turn.agent.tools);

	// a Subagent gets no Subagent Tools, and a step limit whose last request goes without Tools,
	// so it answers with what it has rather than stopping mid-search
	let steps = 0;
	const agent = new Agent({
		initialState: {
			systemPrompt: sub
				? turn.agent.instructions || GENERAL_WORKER
				: turn.agent.instructions,
			model: turn.model,
			thinkingLevel: turn.thinking,
			tools: sub
				? tools
				: [
						...tools,
						...subagentTools(
							config,
							{ model: turn.model, thinking: turn.thinking },
							{ conversationId, userId: conv.userId, notify: send },
						),
					],
			messages: await context(conversationId, rows, turn, streamFn, signal),
		},
		streamFn,
		sessionId: conversationId,
		finishTurn: () =>
			sub && ++steps >= MAX_SUBAGENT_STEPS ? { action: "end" } : undefined,
		// inputs that arrived during a step go to the model right after it
		prepareNextTurnWithContext: async ({ context }) => {
			const messages = (await drain(conversationId)) as Message[];
			if (messages.length) await send({ type: "saved" });
			if (sub && steps === MAX_SUBAGENT_STEPS - 1)
				return {
					context: { ...context, tools: [] },
					messages: [
						...messages,
						{ role: "user", content: STEP_LIMIT, timestamp: Date.now() },
					],
				};
			return messages.length ? { messages } : undefined;
		},
	});
	agent.subscribe(async (event) => {
		await relay(event, send, sub);
		if (event.type !== "message_end") return;
		const { role } = event.message;
		if (role !== "toolResult" && role !== "assistant") return;
		// finished and stopped replies are saved (a stopped one keeps what was generated), and so are Tool results;
		// failed replies are not, the turn is retried instead, dropping everything after the user message
		if (role === "toolResult" || event.message.stopReason !== "error")
			await db.insert(message).values({
				conversationId,
				message: event.message,
				model: modelRef(turn.model),
				thinkingLevel: turn.thinking,
			});
		await send(
			role === "assistant" ? { type: "end", subagent: sub } : { type: "saved" },
		);
	});

	// how a Subagent's Run ended, judged from its last reply
	const ended = () => {
		const replies = (agent.state.messages as Message[]).filter(
			(m): m is AssistantMessage => m.role === "assistant",
		);
		const result =
			replies
				.map(messageText)
				.filter((t) => t.trim())
				.at(-1) ?? "";
		if (signal.aborted) return { outcome: "stopped" as const, result };
		if (steps >= MAX_SUBAGENT_STEPS)
			return { outcome: "partial" as const, result };
		return { outcome: "completed" as const, result };
	};

	signal.throwIfAborted(); // stopped before the reply began
	signal.addEventListener("abort", () => agent.abort());
	let next: Message[] = [];
	for (;;) {
		await (next.length ? agent.prompt(next) : agent.continue());
		const answer = agent.state.messages.at(-1) as AssistantMessage;
		// fails the job so the reason (e.g. an unreadable API key) is logged; runTurn marks the Conversation failed
		if (answer.stopReason === "error")
			throw new Error(answer.errorMessage ?? "The reply failed");
		// stopped: inputs that arrived meanwhile wait for the next Run
		if (signal.aborted) {
			if (sub) await endSubagent(conversationId, ended());
			else await setStatus(conv, "idle");
			break;
		}
		next = (await drain(conversationId, sub ? ended : true)) as Message[];
		await send({ type: "saved" });
		if (!next.length) break;
	}
	if (sub) return;
	const answer = agent.state.messages.at(-1) as AssistantMessage;

	// titled after the first turn that produced a reply, stopped ones included
	const first = !rows.some((r) => r.message.role === "assistant");
	if (first && !conv.titleEdited)
		await generateTitle(conversationId, config, turn.agent.id, [
			last.message,
			answer,
		]).catch((error) => console.error("title generation failed", error));
}

/** The messages the model sees: everything, or the latest summary plus what it kept; compacts first when needed. */
async function context(
	conversationId: string,
	rows: Row[],
	turn: Turn,
	streamFn: StreamFn,
	signal: AbortSignal,
): Promise<AgentMessage[]> {
	const previous = await db.query.compaction.findFirst({
		where: eq(compaction.conversationId, conversationId),
		orderBy: desc(compaction.id),
	});
	let kept = previous
		? rows.slice(rows.findIndex((r) => r.id === previous.firstKeptMessageId))
		: rows;
	let summary = previous?.summary;
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...turn.agent.compaction };
	const visible = (s = summary) => [
		...(s ? [summaryMessage(s)] : []),
		...kept.map((r) => r.message),
	];

	// usage reported before the last compaction measured the uncompacted history
	const trusted = kept.filter(
		(r) => !previous || r.createdAt > previous.createdAt,
	);
	const tokens = contextTokens(visible(), trusted.length);
	if (shouldCompact(tokens, turn.model.contextWindow, settings)) {
		const cut = cutIndex(kept, settings.keepRecentTokens);
		if (cut > 0) {
			const result = await compact(
				{
					firstKeptEntryId: String(kept[cut].id),
					messagesToSummarize: kept.slice(0, cut).map((r) => r.message),
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore: tokens,
					previousSummary: summary,
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					settings,
				},
				turn.model,
				undefined, // auth comes from the registry through streamFn
				undefined,
				undefined,
				signal,
				undefined,
				streamFn,
			);
			signal.throwIfAborted();
			await db.insert(compaction).values({
				conversationId,
				summary: result.summary,
				firstKeptMessageId: kept[cut].id,
				tokensBefore: tokens,
			});
			await notify(conversationId, { type: "saved" });
			summary = result.summary;
			kept = kept.slice(cut);
		}
	}
	return visible(summary);
}

// how pi itself feeds a summary back to the model
const summaryMessage = (summary: string): Message => ({
	role: "user",
	content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
	timestamp: Date.now(),
});

/** Last trustworthy reported usage plus an estimate of what came after it; `trustedTail` counts trailing messages whose usage is valid. */
function contextTokens(messages: Message[], trustedTail: number) {
	for (let i = messages.length - 1; i >= messages.length - trustedTail; i--) {
		const m = messages[i];
		if (
			m.role === "assistant" &&
			m.stopReason !== "error" &&
			m.stopReason !== "aborted"
		)
			return (
				calculateContextTokens(m.usage) +
				messages.slice(i + 1).reduce((n, x) => n + estimateTokens(x), 0)
			);
	}
	return messages.reduce((n, x) => n + estimateTokens(x), 0);
}

/** First kept row: keeps about `keepRecentTokens`, cut at a user message so no turn is split; 0 when nothing can go. */
function cutIndex(rows: { message: Message }[], keepRecentTokens: number) {
	let kept = 0;
	for (let i = rows.length - 1; i > 0; i--) {
		kept += estimateTokens(rows[i].message);
		if (kept < keepRecentTokens) continue;
		const user = rows.findIndex((r, j) => j >= i && r.message.role === "user");
		return Math.max(user, 0);
	}
	return 0;
}

async function generateTitle(
	conversationId: string,
	config: OrqestraConfig,
	agentId: string,
	[question, answer]: [Message, AssistantMessage],
) {
	const turn = resolveTurn(config, agentId);
	if (!turn) return;
	// no reasoning option: thinking stays off
	const stream = await config.streamSimple(turn.model, {
		systemPrompt:
			"Write a title of at most 20 characters for this conversation, in the language the user writes in. Reply with the title only, without quotes or punctuation at the end.",
		messages: [
			{
				role: "user",
				content: `User: ${messageText(question)}\n\nAssistant: ${messageText(answer)}`,
				timestamp: Date.now(),
			},
		],
	});
	const result = await stream.result();
	const title = [
		...messageText(result)
			.trim()
			.replace(/^["'“「]|["'”」]$/g, ""),
	]
		.slice(0, 20)
		.join("");
	if (result.stopReason !== "stop" || !title) return;
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
	await notify(conversationId, { type: "saved" });
}

/**
 * Wraps a streamSimple so each Provider serves at most `max` Model requests at once, counted from the request until its stream ends.
 * The limits live as long as the returned function, so one Provider shares them across configs.
 */
export function providerLimiter(max: number) {
	const limits = new Map<string, ReturnType<typeof limiter>>();
	// shortcut: per worker process; several workers multiply the limit, move to a shared lock if that hits rate limits
	return (
		streamSimple: OrqestraConfig["streamSimple"],
	): OrqestraConfig["streamSimple"] =>
		(model, context, options) => {
			const limit = limits.get(model.provider) ?? limiter(max);
			limits.set(model.provider, limit);
			return new Promise((resolve, reject) => {
				limit(async () => {
					const stream = await streamSimple(model, context, options);
					resolve(stream);
					await stream.result();
				}, options?.signal).catch(reject);
			});
		};
}

/** Starts the BullMQ workers for top-level and Subagent Runs plus the listener for stop requests; resolves to a close function. */
export async function startAgentWorker(
	// read per job: a Run keeps the config it started with, the next one picks up a reload
	getConfig: () => Promise<OrqestraConfig>,
	databaseUrl: string,
	{
		// tests shorten it to see a crashed run fail quickly
		stalledInterval = 30_000,
		concurrency = 8,
		subagentConcurrency = 8,
		providerConcurrency = 8,
	}: {
		stalledInterval?: number;
		/** Top-level Runs this worker works on at once. */
		concurrency?: number;
		/** Subagent Runs this worker works on at once. */
		subagentConcurrency?: number;
		/** Model requests to one Provider at once, across this worker's Runs. */
		providerConcurrency?: number;
	} = {},
) {
	const limitProviders = providerLimiter(providerConcurrency);
	// a pool connection held for good, since LISTEN is per connection
	const listener = await db.$client.connect();
	await listener.query(`LISTEN ${STOP_CHANNEL}`);
	listener.on("notification", (n) => active.get(n.payload ?? "")?.abort());

	const workers = [
		[AGENT_RUNS_QUEUE, concurrency],
		[SUBAGENT_RUNS_QUEUE, subagentConcurrency],
	].map(([queue, concurrency]) => {
		const worker = new Worker(
			queue as string,
			async (job) => {
				const config = await getConfig();
				return runTurn(job.data.conversationId, {
					...config,
					streamSimple: limitProviders(config.streamSimple),
				});
			},
			{
				concurrency: concurrency as number,
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
					console.error("marking the run failed failed", error),
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

/** A failed or crashed Run: a top-level Conversation is marked failed; a Subagent fails, and its Notification wakes the parent. */
async function failed(conversationId: string, error: Error) {
	const conv = await db.query.conversation.findFirst({
		where: eq(conversation.id, conversationId),
	});
	if (!conv) return;
	if (!conv.parentId) return setStatus(conv, "failed");
	await endSubagent(conversationId, {
		outcome: "failed",
		result: `[The subagent failed, or the worker running it crashed: ${error.message}]`,
	});
}

/** Queues again the Runs left running without a job, lost to a crash between saving a Run's start and queueing it. */
async function requeue() {
	const jobs = (
		await Promise.all(
			[false, true].map((subagents) =>
				runQueue(subagents).getJobs([
					"waiting",
					"active",
					"delayed",
					"prioritized",
				]),
			),
		)
	).flat();
	const queued = new Set(jobs.map((j) => j?.data?.conversationId));
	const running = await db
		.select({ id: conversation.id, parentId: conversation.parentId })
		.from(conversation)
		.where(eq(conversation.status, "running"));
	for (const c of running)
		if (!queued.has(c.id)) await enqueue(c.id, !!c.parentId);
}
