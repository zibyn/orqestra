import { memoryStore } from "@orqestra/tools/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Snapshots } from "./index.ts";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { memoriesOf } = await import("@orqestra/memory");
const { createConversations } = await import("./index.ts");
const { noMcpServerDeletes } = await import("./testing.ts");

const newConversation = async (userId: string) =>
	(
		await db
			.insert(schema.conversation)
			.values({ userId, agentId: "a" })
			.returning()
	)[0].id;
afterAll(() => db.$client.end());

describe.skipIf(!url)(
	"Undoing a Memory change from the Conversation (Postgres)",
	() => {
		const conversations = createConversations({
			store: memoryStore().store,
			// no Agents: the Conversation is read-only, which undoing ignores
			capabilities: {
				...noMcpServerDeletes,
				current: async () =>
					({ agents: [], models: [] }) as unknown as Snapshots,
				skillFiles: async () => [],
			},
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
		/** The Agent's memory_write, as its Tool makes it. */
		const write = async (path: string, description: string, body: string) => {
			const toolCallId = `call-${calls + 1}`;
			const { before } = await mine.write(path, description, body, toolCallId);
			return called("memory_write", {
				path,
				before,
				after: { description, body },
			});
		};

		it("reverses the change", async () => {
			await mine.write("p", "d", "old");
			const id = await write("p", "d", "new");
			expect(await conversations.undoMemory("u1", conversationId, id)).toEqual(
				{},
			);
			expect((await mine.read("p"))?.body).toBe("old");
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
			const conv = await conversations.get("u1", conversationId);
			expect(conv?.messages[0].message).not.toMatchObject({
				details: { undone: true },
			});
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
