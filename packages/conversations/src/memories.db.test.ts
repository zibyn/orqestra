import type { OrqestraConfig } from "@orqestra/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Memories, Memory } from "./memories.ts";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { memoriesOf, MAX_MEMORIES, MemoryError, userMemories } = await import(
	"./memories.ts"
);
const { createConversations } = await import("./index.ts");
const { inMemoryMemories } = await import("./testing.ts");

const newConversation = async (userId: string) =>
	(
		await db
			.insert(schema.conversation)
			.values({ userId, agentId: "a" })
			.returning()
	)[0].id;
afterAll(() => db.$client.end());

type Seed = Pick<Memory, "path" | "description" | "body">;
/** The two Memories adapters, run through the same scenarios: they open a User's Memories, seeded, and say which Conversation writes. */
const adapters: {
	name: string;
	skip: boolean;
	open(userId: string, seed?: Seed[]): Promise<[Memories, string]>;
}[] = [
	{
		name: "Postgres",
		skip: !url,
		open: async (userId, seed = []) => {
			if (seed.length)
				await db
					.insert(schema.memory)
					.values(seed.map((m) => ({ userId, ...m })));
			const id = await newConversation(userId);
			return [memoriesOf(userId, id), id];
		},
	},
	{
		name: "in memory",
		skip: false,
		open: async (_userId, seed) => [
			inMemoryMemories(seed, "c1").memories,
			"c1",
		],
	},
];

for (const adapter of adapters)
	describe.skipIf(adapter.skip)(`Memories (${adapter.name})`, () => {
		let mine: Memories;
		let conversationId: string;
		beforeEach(async () => {
			if (url)
				await db.execute(
					sql`truncate conversation, memory, memory_setting cascade`,
				);
			[mine, conversationId] = await adapter.open("u1");
		});

		it("writes, reads, lists and deletes a User's Memories, recording the Conversation that wrote them", async () => {
			expect(
				await mine.write(
					"prefs/language",
					"Replies in English",
					"Use English.",
				),
			).toEqual({ before: undefined });
			await mine.write("work/orqestra", "Working on memory", "Ticket 37");
			expect(await mine.read("prefs/language")).toMatchObject({
				path: "prefs/language",
				description: "Replies in English",
				body: "Use English.",
				conversationId,
				updatedAt: expect.any(Date),
			});
			expect((await mine.index()).map((m) => m.path).sort()).toEqual([
				"prefs/language",
				"work/orqestra",
			]);
			expect(await mine.delete("work/orqestra")).toMatchObject({
				before: { body: "Ticket 37" },
			});
			expect(await mine.read("work/orqestra")).toBeUndefined();
			await expect(mine.delete("work/orqestra")).rejects.toThrow(MemoryError);
		});

		it("keeps one Memory per path: of two writes the later wins", async () => {
			await mine.write("p", "first", "one");
			const { before } = await mine.write("p", "second", "two");
			expect(before).toMatchObject({ description: "first", body: "one" });
			await Promise.all([mine.write("q", "a", "a"), mine.write("q", "b", "b")]);
			expect(await mine.index()).toHaveLength(2);
			expect(await mine.read("p")).toMatchObject({
				description: "second",
				body: "two",
			});
			expect((await mine.read("q"))?.body).toBe("b");
		});

		it("edits a Memory's body by replacing text that occurs once, and refuses otherwise", async () => {
			await mine.write("p", "d", "likes tea, likes cake");
			await mine.edit("p", "tea", "coffee");
			expect((await mine.read("p"))?.body).toBe("likes coffee, likes cake");
			await expect(mine.edit("p", "juice", "x")).rejects.toThrow(/not found/);
			await expect(mine.edit("p", "likes", "x")).rejects.toThrow(/2 times/);
			await expect(mine.edit("nope", "a", "b")).rejects.toThrow(MemoryError);
		});

		it("enforces the limits on path, description, body and count", async () => {
			await expect(mine.write("p", "d".repeat(151), "b")).rejects.toThrow(
				/150/,
			);
			await expect(mine.write("p", "d", "b".repeat(4097))).rejects.toThrow(
				/4096/,
			);
			// each Memory is one line of the Memory Index
			await expect(mine.write("p", "one\ntwo", "b")).rejects.toThrow(
				/one line/,
			);
			await expect(mine.write("p\rq", "d", "b")).rejects.toThrow(/one line/);
			await expect(mine.write("p".repeat(101), "d", "b")).rejects.toThrow(
				/100/,
			);
			await mine.write("p", "d", "b".repeat(4090));
			await expect(mine.edit("p", "b", "")).rejects.toThrow(MemoryError); // occurs many times
			await expect(
				mine.edit("p", "b".repeat(4090), "长".repeat(2000)),
			).rejects.toThrow(/4096/); // bytes, not characters
			[mine] = await adapter.open(
				"u1",
				Array.from({ length: MAX_MEMORIES - 1 }, (_, i) => ({
					path: `bulk/${i}`,
					description: "d",
					body: "b",
				})),
			);
			await mine.write("p", "d", "b");
			await expect(mine.write("one-more", "d", "b")).rejects.toThrow(/500/);
			// replacing one is still allowed at the limit
			await mine.write("p", "d", "short");
		});

		it("greps the path, description and body of the User's own Memories, case-insensitively", async () => {
			await mine.write(
				"prefs/language",
				"Reply language",
				"Use 简体中文 always",
			);
			await mine.write("work/x", "A project", "nothing here");
			const [theirs] = await adapter.open("u2");
			await theirs.write("prefs/language", "other user", "简体中文");
			expect((await mine.grep("简体")).map((m) => m.path)).toEqual([
				"prefs/language",
			]);
			expect((await mine.grep("^work/")).map((m) => m.path)).toEqual([
				"work/x",
			]);
			expect((await mine.grep("a PROJECT")).map((m) => m.path)).toEqual([
				"work/x",
			]);
			await expect(mine.grep("(")).rejects.toThrow(MemoryError);
		});
	});

describe.skipIf(!url)("Memories (Postgres)", () => {
	let mine: ReturnType<typeof memoriesOf>;
	let conversationId: string;
	beforeEach(async () => {
		await db.execute(
			sql`truncate conversation, memory, memory_setting cascade`,
		);
		conversationId = await newConversation("u1");
		mine = memoriesOf("u1", conversationId);
	});

	it("keeps a Memory when the Conversation that wrote it is deleted", async () => {
		await mine.write("p", "d", "b");
		await db
			.delete(schema.conversation)
			.where(sql`${schema.conversation.id} = ${conversationId}`);
		expect(await memoriesOf("u1", conversationId).read("p")).toMatchObject({
			conversationId: null,
		});
	});

	describe("on the User's Memory page", () => {
		it("lists only the User's own Memories, each with the Conversation that wrote it, or none once deleted", async () => {
			await db
				.update(schema.conversation)
				.set({ title: "Planning" })
				.where(sql`${schema.conversation.id} = ${conversationId}`);
			await mine.write("p", "d", "b");
			const gone = await newConversation("u1");
			await memoriesOf("u1", gone).write("q", "e", "c");
			await db
				.delete(schema.conversation)
				.where(sql`${schema.conversation.id} = ${gone}`);
			await memoriesOf("u2", await newConversation("u2")).write("r", "f", "x");
			expect(await userMemories("u1").list()).toEqual([
				expect.objectContaining({
					path: "q",
					conversation: null,
				}),
				expect.objectContaining({
					path: "p",
					description: "d",
					body: "b",
					conversation: { id: conversationId, title: "Planning" },
				}),
			]);
		});

		it("edits a Memory's description and body under the Tools' limits, keeping where it came from", async () => {
			await mine.write("p", "d", "b");
			const page = userMemories("u1");
			await page.update("p", "new", "body");
			expect(await mine.read("p")).toMatchObject({
				description: "new",
				body: "body",
				conversationId,
			});
			await expect(page.update("p", "d".repeat(151), "b")).rejects.toThrow(
				/150/,
			);
			await expect(page.update("p", "d", "b".repeat(4097))).rejects.toThrow(
				/4096/,
			);
			await expect(page.update("p", "one\ntwo", "b")).rejects.toThrow(
				/one line/,
			);
			await expect(page.update("nope", "d", "b")).rejects.toThrow(MemoryError);
			await expect(userMemories("u2").update("p", "x", "y")).rejects.toThrow(
				MemoryError,
			);
		});

		it("deletes one Memory, or all of the User's, leaving other Users' alone", async () => {
			await mine.write("p", "d", "b");
			await mine.write("q", "d", "b");
			const theirs = memoriesOf("u2", await newConversation("u2"));
			await theirs.write("p", "d", "b");
			const page = userMemories("u1");
			await page.delete("p");
			expect((await page.list()).map((m) => m.path)).toEqual(["q"]);
			await expect(userMemories("u2").delete("q")).rejects.toThrow(MemoryError);
			await page.deleteAll();
			expect(await page.list()).toEqual([]);
			expect(await theirs.read("p")).toBeDefined();
		});

		it("keeps memory on until the User turns it off, per User", async () => {
			expect(await userMemories("u1").on()).toBe(true);
			await userMemories("u1").setOn(false);
			expect(await userMemories("u1").on()).toBe(false);
			expect(await userMemories("u2").on()).toBe(true);
			await userMemories("u1").setOn(true);
			expect(await userMemories("u1").on()).toBe(true);
		});
	});
});

describe.skipIf(!url)(
	"Undoing a Memory change from the Conversation (Postgres)",
	() => {
		const conversations = createConversations({
			// no Agents: the Conversation is read-only, which undoing ignores
			config: async () =>
				({ agents: [], models: [] }) as unknown as OrqestraConfig,
			skillFiles: async () => [],
		});
		let conversationId: string;
		let mine: ReturnType<typeof memoriesOf>;
		let calls = 0;
		beforeEach(async () => {
			await db.execute(sql`truncate conversation, memory cascade`);
			conversationId = await newConversation("u1");
			mine = memoriesOf("u1", conversationId);
		});
		/** Saves the result of the Agent's Memory Tool call as a Run does; returns the call's id. */
		const called = async (toolName: string, details: object) => {
			const toolCallId = `call-${++calls}`;
			await db.insert(schema.message).values({
				conversationId,
				model: "faux/faux-1",
				thinkingLevel: "off",
				message: {
					role: "toolResult",
					toolCallId,
					toolName,
					content: [{ type: "text", text: "ok" }],
					details,
					isError: false,
					timestamp: Date.now(),
				},
			});
			return toolCallId;
		};
		const write = async (path: string, description: string, body: string) => {
			const { before } = await mine.write(path, description, body);
			return called("memory_write", {
				path,
				before,
				after: { description, body },
			});
		};

		it("forgets a Memory the Agent created, and restores one it replaced", async () => {
			const created = await write("p", "first", "one");
			await write("q", "d", "old");
			const replaced = await write("q", "d2", "new");
			expect(
				await conversations.undoMemory("u1", conversationId, replaced),
			).toEqual({});
			expect(await mine.read("q")).toMatchObject({
				description: "d",
				body: "old",
			});
			expect(
				await conversations.undoMemory("u1", conversationId, created),
			).toEqual({});
			expect(await mine.read("p")).toBeUndefined();
		});

		it("reverses an edit and a delete", async () => {
			await mine.write("p", "d", "likes tea");
			const { before } = await mine.edit("p", "tea", "coffee");
			const edited = await called("memory_edit", {
				path: "p",
				before,
				old: "tea",
				new: "coffee",
			});
			expect(
				await conversations.undoMemory("u1", conversationId, edited),
			).toEqual({});
			expect((await mine.read("p"))?.body).toBe("likes tea");
			const deleted = await called("memory_delete", {
				path: "p",
				before: (await mine.delete("p")).before,
			});
			expect(
				await conversations.undoMemory("u1", conversationId, deleted),
			).toEqual({});
			expect(await mine.read("p")).toMatchObject({
				description: "d",
				body: "likes tea",
			});
		});

		it("gives a restored Memory back the Conversation that wrote it before, or none once that is deleted", async () => {
			const earlier = await newConversation("u1");
			await memoriesOf("u1", earlier).write("p", "d", "old");
			await memoriesOf("u1", earlier).write("q", "d", "old");
			const replaced = await write("p", "d", "new");
			const deleted = await called("memory_delete", {
				path: "q",
				before: (await mine.delete("q")).before,
			});
			expect(
				await conversations.undoMemory("u1", conversationId, replaced),
			).toEqual({});
			expect(await mine.read("p")).toMatchObject({
				body: "old",
				conversationId: earlier,
			});
			await db
				.delete(schema.conversation)
				.where(sql`${schema.conversation.id} = ${earlier}`);
			expect(
				await conversations.undoMemory("u1", conversationId, deleted),
			).toEqual({});
			expect(await mine.read("q")).toMatchObject({
				body: "old",
				conversationId: null,
			});
		});

		it("tells the pages showing the Conversation that it changed", async () => {
			const id = await write("p", "d", "b");
			const stream = await conversations.subscribe(
				"u1",
				conversationId,
				new AbortController().signal,
			);
			const reader = (stream as ReadableStream<Uint8Array>)
				.pipeThrough(new TextDecoderStream())
				.getReader();
			await conversations.undoMemory("u1", conversationId, id);
			expect((await reader.read()).value).toContain('"saved"');
			await reader.cancel();
		});

		it("marks the change undone, and undoes it only once", async () => {
			const id = await write("p", "d", "b");
			await conversations.undoMemory("u1", conversationId, id);
			const conv = await conversations.get("u1", conversationId);
			expect(conv?.messages[0].message).toMatchObject({
				details: { undone: true },
			});
			expect(await conversations.undoMemory("u1", conversationId, id)).toEqual({
				error: "undone",
			});
		});

		it("refuses when the Memory changed since", async () => {
			const id = await write("p", "d", "b");
			await mine.write("p", "d", "changed");
			expect(await conversations.undoMemory("u1", conversationId, id)).toEqual({
				error: "changed",
			});
			expect((await mine.read("p"))?.body).toBe("changed");
			const gone = await write("q", "d", "b");
			await mine.delete("q");
			expect(
				await conversations.undoMemory("u1", conversationId, gone),
			).toEqual({ error: "changed" });
		});

		it("lets only the Conversation's owner undo, and only Memory changes", async () => {
			const id = await write("p", "d", "b");
			expect(await conversations.undoMemory("u2", conversationId, id)).toEqual({
				error: "not_found",
			});
			expect(await mine.read("p")).toBeDefined();
			const read = await called("memory_read", { path: "p" });
			expect(
				await conversations.undoMemory("u1", conversationId, read),
			).toEqual({ error: "not_found" });
		});
	},
);
