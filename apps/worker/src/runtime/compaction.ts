import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
	type CompactionSettings,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	shouldCompact,
} from "@earendil-works/pi-coding-agent";
import type { Transcript } from "@orqestra/conversations";

/**
 * The messages the model sees: everything, or the latest summary plus what it kept; compacts first when needed,
 * returning the new compaction for the caller to save.
 */
export async function prepareContext(
	transcript: Transcript,
	model: Model<Api>,
	overrides: Partial<CompactionSettings> | undefined,
	{ streamFn, signal }: { streamFn: StreamFn; signal: AbortSignal },
): Promise<{
	messages: AgentMessage[];
	compaction?: { summary: string; firstKeptId: number; tokensBefore: number };
}> {
	const rows = transcript.messages;
	const previous = transcript.compaction;
	const kept = previous
		? rows.slice(rows.findIndex((r) => r.id === previous.firstKeptId))
		: rows;
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...overrides };
	const visible = (summary: string | undefined, from = kept) => [
		...(summary ? [summaryMessage(summary)] : []),
		...from.map((r) => r.message),
	];

	// usage reported before the last compaction measured the uncompacted history
	const trusted = kept.filter(
		(r) => !previous || r.createdAt > previous.createdAt,
	);
	const tokens = contextTokens(visible(previous?.summary), trusted.length);
	if (!shouldCompact(tokens, model.contextWindow, settings))
		return { messages: visible(previous?.summary) };
	const cut = cutIndex(kept, settings.keepRecentTokens);
	if (cut === 0) return { messages: visible(previous?.summary) };
	const result = await compact(
		{
			firstKeptEntryId: String(kept[cut].id),
			messagesToSummarize: kept.slice(0, cut).map((r) => r.message),
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: tokens,
			previousSummary: previous?.summary,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings,
		},
		model,
		undefined, // auth comes from the registry through streamFn
		undefined,
		undefined,
		signal,
		undefined,
		streamFn,
	);
	signal.throwIfAborted();
	return {
		messages: visible(result.summary, kept.slice(cut)),
		compaction: {
			summary: result.summary,
			firstKeptId: kept[cut].id,
			tokensBefore: tokens,
		},
	};
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
