import { describe, expect, it } from "bun:test";
import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type Message,
} from "@earendil-works/pi-ai";
import type { Transcript } from "@orqestra/conversations";
import { prepareContext } from "./compaction.ts";

// a tiny context window so a short history already needs compaction
const faux = fauxProvider({
	provider: "faux",
	models: [{ id: "faux-small", contextWindow: 2000 }],
});
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const settings = { reserveTokens: 1000, keepRecentTokens: 50 };

const user = (content: string): Message => ({
	role: "user",
	content,
	timestamp: 1,
});
const assistant = (text: string, totalTokens = 0) => {
	const m = fauxAssistantMessage(text);
	m.usage.totalTokens = totalTokens;
	return m;
};
const at = (n: number) => new Date(2026, 0, 1, 0, 0, n);
const transcript = (
	messages: Message[],
	compaction?: Transcript["compaction"],
): Transcript => ({
	messages: messages.map((message, i) => ({
		id: i + 1,
		message,
		createdAt: at(i + 1),
	})),
	compaction,
});

// the summarizer's requests, answered with `summary`
function summarizer(summary = "SUMMARY") {
	const requests: Context[] = [];
	faux.setResponses([
		(context) => {
			requests.push(context);
			return fauxAssistantMessage(summary);
		},
	]);
	const streamFn = models.streamSimple.bind(models);
	return { requests, streamFn, signal: new AbortController().signal };
}
const texts = (messages: unknown[]) => JSON.stringify(messages);

describe("prepareContext", () => {
	it("passes a history below the threshold through as it is", async () => {
		const s = summarizer();
		const t = transcript([user("hi"), assistant("hello"), user("next?")]);
		const { messages, compaction } = await prepareContext(
			t,
			model,
			settings,
			s,
		);
		expect(compaction).toBeUndefined();
		expect(s.requests).toHaveLength(0);
		expect(messages).toEqual(t.messages.map((r) => r.message));
	});

	it("summarizes the older Turns and keeps the latest, cut at a User message", async () => {
		const s = summarizer();
		const t = transcript([
			user("a".repeat(4000)),
			assistant("b".repeat(400)),
			user("c"),
			// keepRecentTokens is reached inside this Turn: it goes whole into the summary
			assistant("d".repeat(400), 1500),
			user("next?"),
		]);
		const { messages, compaction } = await prepareContext(
			t,
			model,
			settings,
			s,
		);
		expect(compaction).toMatchObject({ summary: "SUMMARY", firstKeptId: 5 });
		expect(compaction?.tokensBefore).toBeGreaterThan(1000);
		expect(texts(s.requests)).toContain("aaaa");
		expect(messages).toHaveLength(2);
		expect(texts(messages)).toContain("<summary>\\nSUMMARY\\n</summary>");
		expect(messages[1]).toEqual(user("next?"));
	});

	it("ignores usage reported before the last compaction", async () => {
		const history = [
			user("a"),
			user("b"),
			// reported for the uncompacted history
			assistant("c".repeat(400), 1500),
			user("next?"),
		];
		const previous = { summary: "OLD", firstKeptId: 2, createdAt: at(10) };
		const s = summarizer();
		const before = await prepareContext(
			transcript(history, previous),
			model,
			settings,
			s,
		);
		expect(before.compaction).toBeUndefined();
		expect(texts(before.messages)).toContain("<summary>\\nOLD\\n</summary>");
		expect(before.messages.slice(1)).toEqual(history.slice(1));

		// the same usage, reported after it, counts
		const after = await prepareContext(
			transcript(history, { ...previous, createdAt: at(0) }),
			model,
			settings,
			summarizer(),
		);
		expect(after.compaction?.tokensBefore).toBeGreaterThan(1500);
	});

	it("carries the last summary into the next one", async () => {
		const s = summarizer("NEW");
		const t = transcript(
			[
				user("old"),
				user("a".repeat(4000)),
				assistant("b".repeat(400), 1500),
				user("next?"),
			],
			{ summary: "OLD SUMMARY", firstKeptId: 2, createdAt: at(0) },
		);
		const { messages, compaction } = await prepareContext(
			t,
			model,
			settings,
			s,
		);
		expect(texts(s.requests)).toContain("OLD SUMMARY");
		expect(compaction).toMatchObject({ summary: "NEW", firstKeptId: 4 });
		expect(texts(messages)).toContain("<summary>\\nNEW\\n</summary>");
		expect(texts(messages)).not.toContain("OLD SUMMARY");
	});
});
