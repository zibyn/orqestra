import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { memoriesOf, undoChange } = await import("./index.ts");

afterAll(() => db.$client.end());

// the migration's last statement fills memory_change from the Memory Tool results saved before it
const backfill = (
	await readFile(
		new URL("../../db/drizzle/0029_memory_change.sql", import.meta.url),
		"utf8",
	)
)
	.split("--> statement-breakpoint")
	.at(-1) as string;

describe.skipIf(!url)("The migration to Memory changes (Postgres)", () => {
	let conversationId: string;
	beforeEach(async () => {
		await db.execute(sql`truncate conversation, memory cascade`);
		[{ id: conversationId }] = await db
			.insert(schema.conversation)
			.values({ userId: "u1", agentId: "a" })
			.returning();
	});

	/** A Memory Tool result as a Run saved it before the migration. */
	const result = (
		toolCallId: string,
		toolName: string,
		details: object,
		isError = false,
	) =>
		db.insert(schema.message).values({
			conversationId,
			model: "faux/faux-1",
			thinkingLevel: "off",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: "ok" }],
				details,
				isError,
				timestamp: Date.now(),
			},
		});

	it("keeps undoable the Memory changes that were undoable from the Tool results", async () => {
		const [{ id: earlier }] = await db
			.insert(schema.conversation)
			.values({ userId: "u1", agentId: "a" })
			.returning();
		const mine = memoriesOf("u1", conversationId);
		const before = (path: string, description: string, body: string) => ({
			path,
			description,
			body,
			conversationId: earlier,
			updatedAt: new Date().toISOString(),
		});
		// created, and still as it left it
		await mine.write("p", "d", "b");
		await result("created", "memory_write", {
			path: "p",
			after: { description: "d", body: "b" },
		});
		// replaced, then changed again
		await mine.write("q", "d", "later");
		await result("replaced", "memory_write", {
			path: "q",
			before: before("q", "d", "old"),
			after: { description: "d", body: "new" },
		});
		// edited, and still as it left it
		await mine.write("r", "d", "likes coffee");
		await result("edited", "memory_edit", {
			path: "r",
			before: before("r", "d", "likes tea"),
			old: "tea",
			new: "coffee",
		});
		// deleted, and still gone
		await result("deleted", "memory_delete", {
			path: "s",
			before: before("s", "e", "gone"),
		});
		// already undone
		await mine.write("t", "d", "b");
		await result("undone", "memory_write", {
			path: "t",
			after: { description: "d", body: "b" },
			undone: true,
		});
		// refused, and not a change
		await result("failed", "memory_edit", { path: "p" }, true);
		await result("read", "memory_read", undefined as unknown as object);

		await db.execute(sql.raw(backfill));

		const ids = [
			"created",
			"replaced",
			"edited",
			"deleted",
			"undone",
			"failed",
			"read",
		];
		const undoable: string[] = [];
		for (const id of ids)
			if (!(await undoChange("u1", conversationId, id))) undoable.push(id);
		expect(undoable).toEqual(["created", "edited", "deleted"]);
		expect(await mine.read("p")).toBeUndefined();
		expect((await mine.read("q"))?.body).toBe("later");
		expect(await mine.read("r")).toMatchObject({
			body: "likes tea",
			conversationId: earlier,
		});
		expect(await mine.read("s")).toMatchObject({
			description: "e",
			body: "gone",
			conversationId: earlier,
		});
	});
});
