import { db, type Tx } from "@orqestra/db";
import { conversation, memory, memorySetting } from "@orqestra/db/schema";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import type { MemoryChange } from "./shared.ts";

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

/** A Memory Tool's call was refused; the message tells the model what to do instead. */
export class MemoryError extends Error {
	override name = "MemoryError";
}

export type Memory = Pick<
	typeof memory.$inferSelect,
	"path" | "description" | "body" | "conversationId" | "updatedAt"
>;

/** One User's Memories, as their Agent reads and writes them; `before` is the Memory as it was. */
export type Memories = {
	/** Path and description of each, latest updated first: the Memory Index. */
	index(): Promise<Pick<Memory, "path" | "description">[]>;
	read(path: string): Promise<Memory | undefined>;
	/** Creates or replaces the Memory at `path`; of two at once the later wins. */
	write(
		path: string,
		description: string,
		body: string,
	): Promise<{ before?: Memory }>;
	/** Replaces `old`, which must occur once in the body, with `replacement`. */
	edit(
		path: string,
		old: string,
		replacement: string,
	): Promise<{ before: Memory }>;
	delete(path: string): Promise<{ before: Memory }>;
	/** Those whose path, description or body matches the regex `pattern`, ignoring case. */
	grep(pattern: string): Promise<Memory[]>;
};

/** Refuses a Memory over the limits; shared with the in-memory Memories of `memoryRun`. */
export function checkMemory(path: string, description: string, body: string) {
	if (!path.trim()) throw new MemoryError("The path must not be empty.");
	// each Memory is one line of the Memory Index
	if (/[\r\n]/.test(path + description))
		throw new MemoryError(
			"The path and the description must each be one line.",
		);
	if (path.length > MAX_MEMORY_PATH)
		throw new MemoryError(
			`The path has ${path.length} characters; at most ${MAX_MEMORY_PATH} are allowed.`,
		);
	if (description.length > MAX_MEMORY_DESCRIPTION)
		throw new MemoryError(
			`The description has ${description.length} characters; at most ${MAX_MEMORY_DESCRIPTION} are allowed.`,
		);
	const bytes = Buffer.byteLength(body);
	if (bytes > MAX_MEMORY_BODY)
		throw new MemoryError(
			`The body has ${bytes} bytes; at most ${MAX_MEMORY_BODY} are allowed. Shorten it, or split it into several memories.`,
		);
}

export const tooMany = () =>
	new MemoryError(
		`The user already has ${MAX_MEMORIES} memories, the most allowed: merge or delete some first.`,
	);
export const missing = (path: string) =>
	new MemoryError(`There is no memory at ${path}.`);

/** `body` with `old`, which must occur exactly once, replaced. */
export function replaceOnce(body: string, old: string, replacement: string) {
	const count = old ? body.split(old).length - 1 : 0;
	if (count === 0)
		throw new MemoryError("The text to replace was not found in the memory.");
	if (count > 1)
		throw new MemoryError(
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
		conversationId: string | SQL | null;
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

export { MEMORY_CHANGES } from "./shared.ts";

type Content = Pick<Memory, "description" | "body">;
/** The `details` a Memory Tool's result keeps. */
type Change = {
	path: string;
	before?: Content & Pick<Memory, "conversationId">;
	/** memory_write's */
	after?: Content;
	/** memory_edit's */
	old?: string;
	new?: string;
};
/** The Memory as each Memory Tool's call left it, none once deleted. */
const left: Record<MemoryChange, (change: Change) => Content | undefined> = {
	memory_write: (c) => c.after,
	memory_edit: ({ before, old, new: replacement }) =>
		before && {
			description: before.description,
			body: replaceOnce(before.body, old ?? "", replacement ?? ""),
		},
	memory_delete: () => undefined,
};

/**
 * Reverses one Memory Tool call of User `userId` from the `before` its result kept, from the Conversation that wrote it then;
 * `markUndone` runs in the same transaction. Refuses with "changed" when the Memory is no longer as that call left it.
 */
export function undoChange(
	userId: string,
	toolName: MemoryChange,
	change: Change,
	markUndone: (tx: Tx) => Promise<unknown>,
) {
	const { path, before } = change;
	const after = left[toolName](change);
	return lockedFor(
		userId,
		async (tx): Promise<"changed" | "full" | undefined> => {
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
					conversationId: sql`(select ${conversation.id} from ${conversation} where ${conversation.id} = ${before.conversationId})`,
				}))
			)
				return "full";
			await markUndone(tx);
		},
	);
}

/** The Memories of User `userId`, written down as coming from Conversation `conversationId`. */
export function memoriesOf(userId: string, conversationId: string): Memories {
	const at = (path: string) => atFor(userId, path);
	const locked = <T>(fn: (tx: Tx) => Promise<T>) => lockedFor(userId, fn);
	const find = (tx: Tx | typeof db, path: string) => findFor(tx, userId, path);

	return {
		index: () =>
			db
				.select({ path: memory.path, description: memory.description })
				.from(memory)
				.where(eq(memory.userId, userId))
				.orderBy(desc(memory.updatedAt), memory.path),
		read: (path) => find(db, path),
		write: async (path, description, body) => {
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
				return { before };
			});
		},
		edit: (path, old, replacement) =>
			locked(async (tx) => {
				const before = await find(tx, path);
				if (!before) throw missing(path);
				const body = replaceOnce(before.body, old, replacement);
				checkMemory(path, before.description, body);
				await tx
					.update(memory)
					.set({ body, conversationId, updatedAt: new Date() })
					.where(at(path));
				return { before };
			}),
		delete: (path) =>
			locked(async (tx) => {
				const [before] = await tx
					.delete(memory)
					.where(at(path))
					.returning(columns);
				if (!before) throw missing(path);
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
					throw new MemoryError(
						`Invalid regular expression: ${(cause as Error).message}`,
					);
				throw error;
			}
		},
	};
}
