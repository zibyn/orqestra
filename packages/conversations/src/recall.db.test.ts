import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { recallOf, MAX_RECALL_RESULTS, MAX_SNIPPET } = await import(
	"./recall.ts"
);

const newConversation = async (
	userId: string,
	values: { title?: string; parentId?: string; incognito?: boolean } = {},
) =>
	(
		await db
			.insert(schema.conversation)
			.values({ userId, agentId: "a", ...values })
			.returning()
	)[0].id;
const say = (conversationId: string, message: object, createdAt = new Date()) =>
	db.insert(schema.message).values({
		conversationId,
		message,
		model: "m",
		thinkingLevel: "off",
		createdAt,
	});
const user = (content: string) => ({ role: "user", content, timestamp: 0 });
const assistant = (text: string) => ({
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "hidden thoughts" },
		{ type: "text", text },
	],
});

describe.skipIf(!url)("Recall (Postgres)", () => {
	let current: string;
	let past: string;
	beforeEach(async () => {
		await db.execute(sql`truncate conversation cascade`);
		current = await newConversation("u1");
		past = await newConversation("u1", { title: "Trip planning" });
	});
	afterAll(() => db.$client.end());

	it("finds the User's past messages by keyword, ignoring case, with their Conversation and time", async () => {
		const at = new Date("2026-01-02T03:04:05Z");
		await say(past, user("I am flying to Lisbon in March"), at);
		await say(past, assistant("Lisbon is lovely in spring"), at);
		const found = await recallOf("u1", current).search("LISBON");
		expect(found).toHaveLength(2);
		expect(found[0]).toMatchObject({
			conversationId: past,
			title: "Trip planning",
			at,
		});
		expect(found.map((f) => f.snippet).sort()).toEqual([
			"I am flying to Lisbon in March",
			"Lisbon is lovely in spring",
		]);
	});

	it("finds Chinese keywords, short ones too", async () => {
		await say(past, user("我下个月去杭州出差，帮我记一下"));
		const mine = recallOf("u1", current);
		expect(await mine.search("杭州出差")).toHaveLength(1);
		expect(await mine.search("杭州")).toHaveLength(1);
		expect(await mine.search("杭")).toHaveLength(1);
		expect(await mine.search("上海")).toHaveLength(0);
	});

	it("skips the current Conversation, other Users', Subagents' and what is not message text", async () => {
		await say(current, user("kiwi here"));
		await say(await newConversation("u2"), user("kiwi there"));
		await say(
			await newConversation("u1", { parentId: past }),
			user("kiwi below"),
		);
		await say(past, assistant("no fruit"));
		await say(past, {
			role: "toolResult",
			content: [{ type: "text", text: "kiwi from a tool" }],
		});
		const mine = recallOf("u1", current);
		expect(await mine.search("kiwi")).toEqual([]);
		expect(await mine.search("hidden")).toEqual([]);
		expect(await mine.search("text")).toEqual([]);
	});

	it("never finds or opens an Incognito Conversation", async () => {
		const incognito = await newConversation("u1", { incognito: true });
		await say(incognito, user("kiwi in secret"));
		const mine = recallOf("u1", current);
		expect(await mine.search("kiwi")).toEqual([]);
		expect(await mine.open(incognito)).toBeUndefined();
	});

	it("treats % and _ in the keyword as text", async () => {
		await say(past, user("a 100% match"));
		await say(past, user("another one"));
		const mine = recallOf("u1", current);
		expect(await mine.search("100%")).toHaveLength(1);
		expect(await mine.search("%")).toHaveLength(1);
		expect(await mine.search("_")).toHaveLength(0);
	});

	it("filters by time, latest first, and caps results and snippets", async () => {
		for (let day = 1; day <= MAX_RECALL_RESULTS + 5; day++)
			await say(
				past,
				user(`${"x".repeat(1000)} needle ${"y".repeat(1000)}`),
				new Date(Date.UTC(2026, 0, day)),
			);
		const mine = recallOf("u1", current);
		const all = await mine.search("needle");
		expect(all).toHaveLength(MAX_RECALL_RESULTS);
		expect(all[0].at).toEqual(new Date(Date.UTC(2026, 0, 25)));
		expect(all[0].snippet.length).toBeLessThanOrEqual(MAX_SNIPPET + 2);
		expect(all[0].snippet).toContain("needle");
		const some = await mine.search("needle", {
			after: new Date(Date.UTC(2026, 0, 3)),
			before: new Date(Date.UTC(2026, 0, 5)),
		});
		expect(some.map((f) => f.at.getUTCDate())).toEqual([5, 4, 3]);
	});

	it("opens one of the User's past Conversations, and none of anyone else's", async () => {
		await say(past, user("where to?"), new Date("2026-01-01T00:00:00Z"));
		await say(past, assistant("Lisbon"), new Date("2026-01-01T00:01:00Z"));
		const mine = recallOf("u1", current);
		expect(await mine.open(past)).toEqual({
			title: "Trip planning",
			messages: [
				{
					role: "user",
					text: "where to?",
					at: new Date("2026-01-01T00:00:00Z"),
				},
				{
					role: "assistant",
					text: "Lisbon",
					at: new Date("2026-01-01T00:01:00Z"),
				},
			],
		});
		expect(await mine.open(current)).toBeUndefined();
		expect(await mine.open(await newConversation("u2"))).toBeUndefined();
		expect(await mine.open("not-a-uuid")).toBeUndefined();
	});
});
