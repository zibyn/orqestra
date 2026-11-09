import { db, type Tx } from "@orqestra/db";
import { memory } from "@orqestra/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

/** Memories one User may have. */
export const MAX_MEMORIES = 500;
/** Bytes of a Memory's body. */
export const MAX_MEMORY_BODY = 4096;
/** Characters of a Memory's description. */
export const MAX_MEMORY_DESCRIPTION = 150;
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

/** The Memories of User `userId`, written down as coming from Conversation `conversationId`. */
export function memoriesOf(userId: string, conversationId: string): Memories {
	const at = (path: string) =>
		and(eq(memory.userId, userId), eq(memory.path, path));
	// a User's writes go one at a time, so the count and `before` hold
	const locked = <T>(fn: (tx: Tx) => Promise<T>) =>
		db.transaction(async (tx) => {
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
			return fn(tx);
		});
	const find = async (tx: Tx | typeof db, path: string) =>
		(await tx.select(columns).from(memory).where(at(path)))[0];

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
				if (!before) {
					const [{ n }] = await tx
						.select({ n: sql<number>`count(*)::int` })
						.from(memory)
						.where(eq(memory.userId, userId));
					if (n >= MAX_MEMORIES) throw tooMany();
				}
				const values = {
					description,
					body,
					conversationId,
					updatedAt: new Date(),
				};
				await tx
					.insert(memory)
					.values({ userId, path, ...values })
					.onConflictDoUpdate({
						target: [memory.userId, memory.path],
						set: values,
					});
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
