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
	type OrqestraConfig,
	resolveTurn,
} from "@orqestra/config";
import {
	createConversations,
	type RunHandle,
	type Transcript,
} from "@orqestra/conversations";
import { mcpTools } from "./mcp.ts";
import {
	limiter,
	MAX_SUBAGENT_STEPS,
	relay,
	STEP_LIMIT,
	searchTools,
	subagentTools,
} from "./tools.ts";

/**
 * Replies to one Run, step by step, until no input is left: the Agent loop, compaction and the title.
 * A failed reply throws, and the Run fails.
 */
export async function reply(run: RunHandle, config: OrqestraConfig) {
	const { conversationId, turn, signal } = run;
	const sub = run.isSubagent;
	const rows = run.transcript.messages;
	const last = rows.at(-1) as Transcript["messages"][number];
	const streamFn: StreamFn = config.streamSimple;
	const tools = searchTools(config, turn.agent.tools);
	// connected for this Run only, so changes on the server side show up in the next one
	const mcp = await mcpTools(config, turn.agent.tools, signal);
	try {
		// a Subagent gets no Subagent Tools, and a step limit whose last request goes without Tools,
		// so it answers with what it has rather than stopping mid-search
		let steps = 0;
		const agent = new Agent({
			initialState: {
				systemPrompt: turn.agent.instructions,
				model: turn.model,
				thinkingLevel: turn.thinking,
				tools: sub
					? [...tools, ...mcp.tools]
					: [...tools, ...mcp.tools, ...subagentTools(config, run.subagents)],
				messages: await context(run, streamFn),
			},
			streamFn,
			sessionId: conversationId,
			finishTurn: () =>
				sub && ++steps >= MAX_SUBAGENT_STEPS ? { action: "end" } : undefined,
			// inputs that arrived during a step go to the model right after it
			prepareNextTurnWithContext: async ({ context }) => {
				const messages = await run.deliver();
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
			await relay(event, run.stream);
			if (event.type !== "message_end") return;
			const { role } = event.message;
			if (role !== "toolResult" && role !== "assistant") return;
			// finished and stopped replies are saved (a stopped one keeps what was generated), and so are Tool results;
			// failed replies are not, the turn is retried instead, dropping everything after the user message
			if (role === "toolResult" || event.message.stopReason !== "error")
				await run.save(event.message);
		});

		// how the Run ended, judged from its last reply
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
			// fails the job so the reason (e.g. an unreadable API key) is logged; the Run is then marked failed
			if (answer.stopReason === "error")
				throw new Error(answer.errorMessage ?? "The reply failed");
			next = await run.finish(sub ? ended() : undefined);
			if (!next.length) break;
		}
		if (sub) return;
		const answer = agent.state.messages.at(-1) as AssistantMessage;

		// titled after the first turn that produced a reply, stopped ones included
		const first = !rows.some((r) => r.message.role === "assistant");
		if (first && !run.renamed)
			await generateTitle(run, config, turn.agent.id, [
				last.message,
				answer,
			]).catch((error) => console.error("title generation failed", error));
	} finally {
		await mcp.close();
	}
}

/** The messages the model sees: everything, or the latest summary plus what it kept; compacts first when needed. */
async function context(
	{ transcript, turn, signal, compacted }: RunHandle,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const rows = transcript.messages;
	const previous = transcript.compaction;
	let kept = previous
		? rows.slice(rows.findIndex((r) => r.id === previous.firstKeptId))
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
			await compacted(result.summary, kept[cut].id, tokens);
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
	run: RunHandle,
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
	await run.setTitle(title);
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

/** Works on queued Runs in this process, replying to each, until the returned close function is called. */
export function startAgentWorker(
	// read per Run: a Run keeps the config it started with, the next one picks up a reload
	getConfig: () => Promise<OrqestraConfig>,
	{
		providerConcurrency = 8,
		...options
	}: Parameters<ReturnType<typeof createConversations>["serveRuns"]>[1] & {
		/** Model requests to one Provider at once, across this worker's Runs. */
		providerConcurrency?: number;
	} = {},
) {
	const limitProviders = providerLimiter(providerConcurrency);
	return createConversations({ config: getConfig }).serveRuns(async (run) => {
		const config = await getConfig();
		await reply(run, {
			...config,
			streamSimple: limitProviders(config.streamSimple),
		});
	}, options);
}
