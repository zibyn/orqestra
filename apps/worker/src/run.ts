import {
	Agent,
	type AgentMessage,
	type AgentTool,
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

type Turn = NonNullable<ReturnType<typeof resolveTurn>>;
type Row = typeof message.$inferSelect & { message: Message };

/** Runs in this process, by Conversation id, so a stop request can abort them. */
const active = new Map<string, Agent>();

const notify = (conversationId: string, event: ConversationEvent) =>
	db.execute(
		sql`select pg_notify(${conversationChannel(conversationId)}, ${JSON.stringify(event)})`,
	);

async function setStatus(
	conversationId: string,
	status: "idle" | "running" | "failed",
) {
	await db
		.update(conversation)
		.set({ status })
		.where(eq(conversation.id, conversationId));
	await notify(conversationId, { type: "saved" });
}

/** Replies to the last (user) message of a Conversation. */
export async function runTurn(conversationId: string, config: OrqestraConfig) {
	try {
		await reply(conversationId, config);
	} catch (error) {
		await setStatus(conversationId, "failed");
		throw error;
	}
}

async function reply(conversationId: string, config: OrqestraConfig) {
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
	const streamFn: StreamFn = (model, context, options) =>
		config.registry.streamSimple(model, context, options);

	const agent = new Agent({
		initialState: {
			systemPrompt: turn.agent.instructions,
			model: turn.model,
			thinkingLevel: turn.thinking,
			tools: [] as AgentTool[], // no tools yet; they plug in here
			messages: await context(conversationId, rows, turn, streamFn),
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
		// only finished replies are saved; aborted and failed ones too, so the UI can show them
		if (event.type === "message_end" && event.message.role === "assistant")
			await db.insert(message).values({
				conversationId,
				message: event.message,
				model: modelRef(turn.model),
				thinkingLevel: turn.thinking,
			});
	});

	active.set(conversationId, agent);
	try {
		await agent.continue();
	} finally {
		active.delete(conversationId);
	}
	const answer = agent.state.messages.at(-1) as AssistantMessage;
	await setStatus(
		conversationId,
		answer.stopReason === "error" ? "failed" : "idle",
	);

	if (!conv.title && !conv.titleEdited && answer.stopReason === "stop")
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
				undefined,
				undefined,
				streamFn,
			);
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
	const text = (m: Message) =>
		typeof m.content === "string"
			? m.content
			: m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	// no reasoning option: thinking stays off
	const result = await config.registry.complete(turn.model, {
		systemPrompt:
			"Write a title of at most 20 characters for this conversation, in the language the user writes in. Reply with the title only, without quotes or punctuation at the end.",
		messages: [
			{
				role: "user",
				content: `User: ${text(question)}\n\nAssistant: ${text(answer)}`,
				timestamp: Date.now(),
			},
		],
	});
	const title = [
		...text(result)
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
	config: OrqestraConfig,
	databaseUrl: string,
) {
	// a pool connection held for good, since LISTEN is per connection
	const listener = await db.$client.connect();
	await listener.query(`LISTEN ${STOP_CHANNEL}`);
	listener.on("notification", (n) => active.get(n.payload ?? "")?.abort());

	const worker = new Worker(
		AGENT_RUNS_QUEUE,
		(job) => runTurn(job.data.conversationId, config),
		{
			// bullmq tables live in their own "bullmq" schema; migrate is advisory-locked across processes
			connection: { connectionString: databaseUrl, migrate: true },
			// a run lost to a crashed worker fails instead of re-running; the UI offers a retry
			maxStalledCount: 0,
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
