import { db, type Tx } from "@orqestra/db";
import {
	conversation,
	memory,
	memoryChange,
	memorySetting,
} from "@orqestra/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

/** Memories one User may have. */
export const MAX_MEMORIES = 500;
/** Bytes of a Memory's body. */
export const MAX_MEMORY_BODY = 4096;
/** Characters of a Memory's description. */
export const MAX_MEMORY_DESCRIPTION = 150;
/** Characters of a Memory's path. */
export const MAX_MEMORY_PATH = 100;
/** Memories one grep returns. */
export const MAX_GREP_RESULTS = 50;

/** A Memory Tool's call was refused; the message tells the model what to do instead. Either an InvalidMemory or a MemoryNotFound. */
export class MemoryError extends Error {
	override name = "MemoryError";
}
/** The change is refused as it stands: over a limit, text to replace not found once, a bad regex. */
export class InvalidMemory extends MemoryError {
	override name = "InvalidMemory";
}
/** There is no Memory at the path, of the User's. */
export class MemoryNotFound extends MemoryError {
	override name = "MemoryNotFound";
}

export type Memory = Pick<
	typeof memory.$inferSelect,
	"path" | "description" | "body" | "conversationId" | "updatedAt"
>;

/**
 * One User's Memories, as their Agent reads and writes them; `before` is the Memory as it was.
 * A change made with the Agent's `toolCallId` is recorded, so the User can undo it (`undoChange`).
 */
export type Memories = {
	/** Path and description of each, latest updated first: the Memory Index. */
	index(): Promise<Pick<Memory, "path" | "description">[]>;
	read(path: string): Promise<Memory | undefined>;
	/** Creates or replaces the Memory at `path`; of two at once the later wins. */
	write(
		path: string,
		description: string,
		body: string,
		toolCallId?: string,
	): Promise<{ before?: Memory }>;
	/** Replaces `old`, which must occur once in the body, with `replacement`. */
	edit(
		path: string,
		old: string,
		replacement: string,
		toolCallId?: string,
	): Promise<{ before: Memory }>;
	delete(path: string, toolCallId?: string): Promise<{ before: Memory }>;
	/** Those whose path, description or body matches the regex `pattern`, ignoring case. */
	grep(pattern: string): Promise<Memory[]>;
};

/** Refuses a Memory over the limits; shared with the in-memory Memories of `memoryRun`. */
export function checkMemory(path: string, description: string, body: string) {
	if (!path.trim()) throw new InvalidMemory("The path must not be empty.");
	// each Memory is one line of the Memory Index
	if (/[\r\n]/.test(path + description))
		throw new InvalidMemory(
			"The path and the description must each be one line.",
		);
	if (path.length > MAX_MEMORY_PATH)
		throw new InvalidMemory(
			`The path has ${path.length} characters; at most ${MAX_MEMORY_PATH} are allowed.`,
		);
	if (description.length > MAX_MEMORY_DESCRIPTION)
		throw new InvalidMemory(
			`The description has ${description.length} characters; at most ${MAX_MEMORY_DESCRIPTION} are allowed.`,
		);
	const bytes = Buffer.byteLength(body);
	if (bytes > MAX_MEMORY_BODY)
		throw new InvalidMemory(
			`The body has ${bytes} bytes; at most ${MAX_MEMORY_BODY} are allowed. Shorten it, or split it into several memories.`,
		);
}

export const tooMany = () =>
	new InvalidMemory(
		`The user already has ${MAX_MEMORIES} memories, the most allowed: merge or delete some first.`,
	);
export const missing = (path: string) =>
	new MemoryNotFound(`There is no memory at ${path}.`);

/** `body` with `old`, which must occur exactly once, replaced. */
export function replaceOnce(body: string, old: string, replacement: string) {
	const count = old ? body.split(old).length - 1 : 0;
	if (count === 0)
		throw new InvalidMemory("The text to replace was not found in the memory.");
	if (count > 1)
		throw new InvalidMemory(
			`The text to replace occurs ${count} times in the memory: include more of it, so it occurs once.`,
		);
	return body.replace(old, () => replacement);
}

const columns = {
	path: memory.path,
	description: memory.description,
	body: memory.body,
	conversationId: memory.conversationId,
	updatedAt: memory.updatedAt,
};

/** User `userId`'s Memories as their Memory page shows and changes them, and their memory master switch. */
export function userMemories(userId: string) {
	const at = (path: string) => atFor(userId, path);
	const found = (rows: unknown[], path: string) => {
		if (!rows.length) throw missing(path);
	};
	return {
		/** Latest updated first, each with the Conversation that last wrote it, null once that is deleted. */
		list: async () =>
			(
				await db
					.select({
						...columns,
						title: conversation.title,
					})
					.from(memory)
					.leftJoin(conversation, eq(conversation.id, memory.conversationId))
					.where(eq(memory.userId, userId))
					.orderBy(desc(memory.updatedAt), memory.path)
			).map(({ title, ...m }) => ({
				...m,
				conversation: m.conversationId ? { id: m.conversationId, title } : null,
			})),
		/** Replaces its description and body, under the same limits as the Memory Tools. */
		async update(path: string, description: string, body: string) {
			checkMemory(path, description, body);
			found(
				await db
					.update(memory)
					.set({ description, body, updatedAt: new Date() })
					.where(at(path))
					.returning({ id: memory.id }),
				path,
			);
		},
		async delete(path: string) {
			found(
				await db.delete(memory).where(at(path)).returning({ id: memory.id }),
				path,
			);
		},
		deleteAll: () => db.delete(memory).where(eq(memory.userId, userId)),
		/** The master switch: off, the Memories stay but the User's next Runs neither read nor write them. */
		on: () => memoryOn(userId),
		setOn: (enabled: boolean) =>
			db
				.insert(memorySetting)
				.values({ userId, enabled })
				.onConflictDoUpdate({ target: memorySetting.userId, set: { enabled } }),
	};
}

export const memoryOn = async (userId: string) =>
	(
		await db
			.select({ enabled: memorySetting.enabled })
			.from(memorySetting)
			.where(eq(memorySetting.userId, userId))
	)[0]?.enabled ?? true;

// a User's writes go one at a time, so the count and `before` hold
const lockedFor = <T>(userId: string, fn: (tx: Tx) => Promise<T>) =>
	db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
		return fn(tx);
	});
const atFor = (userId: string, path: string) =>
	and(eq(memory.userId, userId), eq(memory.path, path));
const findFor = async (tx: Tx | typeof db, userId: string, path: string) =>
	(await tx.select(columns).from(memory).where(atFor(userId, path)))[0];

/** Creates or replaces User `userId`'s Memory at `path`; false, writing nothing, when that would create one past MAX_MEMORIES. */
async function upsert(
	tx: Tx,
	userId: string,
	path: string,
	exists: boolean,
	set: Pick<typeof memory.$inferInsert, "description" | "body"> & {
		conversationId: string | null;
	},
) {
	if (!exists) {
		const [{ n }] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(memory)
			.where(eq(memory.userId, userId));
		if (n >= MAX_MEMORIES) return false;
	}
	const values = { ...set, updatedAt: new Date() };
	await tx
		.insert(memory)
		.values({ userId, path, ...values })
		.onConflictDoUpdate({ target: [memory.userId, memory.path], set: values });
	return true;
}

type Content = Pick<Memory, "description" | "body">;
const content = (m: Content | undefined) =>
	m && { description: m.description, body: m.body };

/** Why `undoChange` did not undo: no such change, already undone, the Memory changed since, or restoring it would pass MAX_MEMORIES. */
export type Undone = "not_found" | "undone" | "changed" | "full";

/**
 * Reverses the Memory change Tool call `toolCallId` of User `userId`'s Conversation `conversationId` made, from its record,
 * restoring the Conversation that wrote the Memory before; `then` runs in the same transaction, and rolls it back by throwing.
 * Refuses with "changed" when the Memory is no longer as that call left it, so a later change is never lost.
 */
export function undoChange(
	userId: string,
	conversationId: string,
	toolCallId: string,
	then?: (tx: Tx) => Promise<unknown>,
) {
	return lockedFor(userId, async (tx): Promise<Undone | undefined> => {
		const [change] = await tx
			.select()
			.from(memoryChange)
			.where(
				and(
					eq(memoryChange.userId, userId),
					eq(memoryChange.conversationId, conversationId),
					eq(memoryChange.toolCallId, toolCallId),
				),
			);
		if (!change) return "not_found";
		if (change.undone) return "undone";
		const { path, before, after } = change;
		const now = await findFor(tx, userId, path);
		const same = after
			? now?.description === after.description && now.body === after.body
			: !now;
		if (!same) return "changed";
		if (!before) await tx.delete(memory).where(atFor(userId, path));
		else if (
			!(await upsert(tx, userId, path, !!now, {
				description: before.description,
				body: before.body,
				// null once that Conversation is deleted, as it would have been
				conversationId: change.beforeConversationId,
			}))
		)
			return "full";
		await tx
			.update(memoryChange)
			.set({ undone: true })
			.where(eq(memoryChange.id, change.id));
		await then?.(tx);
	});
}

/** The Memories of User `userId`, written down as coming from Conversation `conversationId`. */
export function memoriesOf(userId: string, conversationId: string): Memories {
	const at = (path: string) => atFor(userId, path);
	const locked = <T>(fn: (tx: Tx) => Promise<T>) => lockedFor(userId, fn);
	const find = (tx: Tx | typeof db, path: string) => findFor(tx, userId, path);
	/** Records the change of Tool call `toolCallId`, when made by one; a call made again replaces its record. */
	const record = async (
		tx: Tx,
		toolCallId: string | undefined,
		path: string,
		before: Memory | undefined,
		after: Content | undefined,
	) => {
		if (!toolCallId) return;
		const change = {
			userId,
			path,
			before: content(before) ?? null,
			beforeConversationId: before?.conversationId ?? null,
			after: content(after) ?? null,
			undone: false,
		};
		await tx
			.insert(memoryChange)
			.values({ conversationId, toolCallId, ...change })
			.onConflictDoUpdate({
				target: [memoryChange.conversationId, memoryChange.toolCallId],
				set: change,
			});
	};

	return {
		index: () =>
			db
				.select({ path: memory.path, description: memory.description })
				.from(memory)
				.where(eq(memory.userId, userId))
				.orderBy(desc(memory.updatedAt), memory.path),
		read: (path) => find(db, path),
		write: async (path, description, body, toolCallId) => {
			checkMemory(path, description, body);
			return locked(async (tx) => {
				const before = await find(tx, path);
				if (
					!(await upsert(tx, userId, path, !!before, {
						description,
						body,
						conversationId,
					}))
				)
					throw tooMany();
				await record(tx, toolCallId, path, before, { description, body });
				return { before };
			});
		},
		edit: (path, old, replacement, toolCallId) =>
			locked(async (tx) => {
				const before = await find(tx, path);
				if (!before) throw missing(path);
				const body = replaceOnce(before.body, old, replacement);
				checkMemory(path, before.description, body);
				await tx
					.update(memory)
					.set({ body, conversationId, updatedAt: new Date() })
					.where(at(path));
				await record(tx, toolCallId, path, before, {
					description: before.description,
					body,
				});
				return { before };
			}),
		delete: (path, toolCallId) =>
			locked(async (tx) => {
				const [before] = await tx
					.delete(memory)
					.where(at(path))
					.returning(columns);
				if (!before) throw missing(path);
				await record(tx, toolCallId, path, before, undefined);
				return { before };
			}),
		grep: async (pattern) => {
			try {
				return await db
					.select(columns)
					.from(memory)
					.where(
						and(
							eq(memory.userId, userId),
							sql`(${memory.path} ~* ${pattern} or ${memory.description} ~* ${pattern} or ${memory.body} ~* ${pattern})`,
						),
					)
					.orderBy(desc(memory.updatedAt), memory.path)
					.limit(MAX_GREP_RESULTS);
			} catch (error) {
				// 2201B: invalid_regular_expression
				const cause =
					(error as { cause?: { code?: string; message?: string } }).cause ??
					error;
				if ((cause as { code?: string }).code === "2201B")
					throw new InvalidMemory(
						`Invalid regular expression: ${(cause as Error).message}`,
					);
				throw error;
			}
		},
	};
}
