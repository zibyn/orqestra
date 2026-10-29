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
	sql,
} from "@orqestra/db";
import { compaction, conversation, message } from "@orqestra/db/schema";
import { createPostgresBackend, Worker } from "bullmq";
import { subagentTool, searchTools } from "./tools.ts";

type Turn = NonNullable<ReturnType<typeof resolveTurn>>;
type Row = typeof message.$inferSelect & { message: Message };

/** Runs in this process, by Conversation id, so a stop request can abort them from the start (compaction included). */
const active = new Map<string, AbortController>();

const notify = (conversationId: string, event: ConversationEvent) =>
	db.execute(
		sql`select pg_notify(${conversationChannel(conversationId)}, ${JSON.stringify(event)})`,
	);

async function setStatus(
	conversationId: string,
	status: (typeof conversation.$inferSelect)["status"],
) {
	await db
		.update(conversation)
		.set({ status })
		.where(eq(conversation.id, conversationId));
	await notify(conversationId, { type: "saved" });
}

/** Replies to the last (user) message of a Conversation. */
export async function runTurn(conversationId: string, config: OrqestraConfig) {
	const stop = new AbortController();
	active.set(conversationId, stop);
	try {
		await reply(conversationId, config, stop.signal);
	} catch (error) {
		// stopped while compacting: nothing to save
		if (stop.signal.aborted) return setStatus(conversationId, "idle");
		await setStatus(conversationId, "failed");
		throw error;
	} finally {
		active.delete(conversationId);
	}
}

async function reply(
	conversationId: string,
	config: OrqestraConfig,
	signal: AbortSignal,
) {
	const conv = await db.query.conversation.findFirst({
		where: eq(conversation.id, conversationId),
	});
	if (!conv) return; // deleted while queued
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

	const agent = new Agent({
		initialState: {
			systemPrompt: turn.agent.instructions,
			model: turn.model,
			thinkingLevel: turn.thinking,
			tools: [
				...tools,
				subagentTool(
					config,
					{ model: turn.model, thinking: turn.thinking },
					tools,
				),
			],
			messages: await context(conversationId, rows, turn, streamFn, signal),
		},
		streamFn,
		sessionId: conversationId,
	});
	agent.subscribe(async (event) => {
		if (event.type === "message_start" && event.message.role === "assistant")
			await notify(conversationId, { type: "start" });
		if (event.type === "message_update") {
			const e = event.assistantMessageEvent;
			if (e.type === "text_delta" || e.type === "thinking_delta")
				await notify(conversationId, {
					type: "delta",
					kind: e.type === "text_delta" ? "text" : "thinking",
					index: e.contentIndex,
					delta: e.delta,
				});
		}
		// finished and stopped replies are saved (a stopped one keeps what was generated), and so are Tool results;
		// failed replies are not, the turn is retried instead, dropping everything after the user message
		if (
			event.type === "message_end" &&
			(event.message.role === "toolResult" ||
				(event.message.role === "assistant" &&
					event.message.stopReason !== "error"))
		) {
			await db.insert(message).values({
				conversationId,
				message: event.message,
				model: modelRef(turn.model),
				thinkingLevel: turn.thinking,
			});
			await notify(conversationId, { type: "saved" });
		}
	});

	signal.throwIfAborted(); // stopped before the reply began
	signal.addEventListener("abort", () => agent.abort());
	await agent.continue();
	const answer = agent.state.messages.at(-1) as AssistantMessage;
	// fails the job so the reason (e.g. an unreadable API key) is logged; runTurn marks the Conversation failed
	if (answer.stopReason === "error")
		throw new Error(answer.errorMessage ?? "The reply failed");
	await setStatus(conversationId, "idle");

	// titled after the first turn that produced a reply, stopped ones included
	const first = !rows.some((r) => r.message.role === "assistant");
	if (first && !conv.titleEdited)
		await generateTitle(conversationId, config, conv.agentId, [
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
	const result = await config
		.streamSimple(turn.model, {
			systemPrompt:
				"Write a title of at most 20 characters for this conversation, in the language the user writes in. Reply with the title only, without quotes or punctuation at the end.",
			messages: [
				{
					role: "user",
					content: `User: ${messageText(question)}\n\nAssistant: ${messageText(answer)}`,
					timestamp: Date.now(),
				},
			],
		})
		.result();
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

/** Starts the BullMQ worker for agent runs plus the listener for stop requests; resolves to a close function. */
export async function startAgentWorker(
	// read per job: a Run keeps the config it started with, the next one picks up a reload
	getConfig: () => Promise<OrqestraConfig>,
	databaseUrl: string,
	// tests shorten it to see a crashed run fail quickly
	{ stalledInterval = 30_000 }: { stalledInterval?: number } = {},
) {
	// a pool connection held for good, since LISTEN is per connection
	const listener = await db.$client.connect();
	await listener.query(`LISTEN ${STOP_CHANNEL}`);
	listener.on("notification", (n) => active.get(n.payload ?? "")?.abort());

	const worker = new Worker(
		AGENT_RUNS_QUEUE,
		async (job) => runTurn(job.data.conversationId, await getConfig()),
		{
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
		if (job) void setStatus(job.data.conversationId, "failed");
	});
	worker.on("error", (err) => console.error("worker error", err));
	// the pg backend doesn't emit 'error' on connect failure, so fail fast instead of idling silently
	await worker.waitUntilReady();

	return async () => {
		await worker.close();
		listener.release(true); // destroy rather than return a LISTENing connection to the pool
	};
}
