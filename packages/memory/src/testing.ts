import {
	checkMemory,
	InvalidMemory,
	MAX_GREP_RESULTS,
	MAX_MEMORIES,
	type Memories,
	type Memory,
	missing,
	replaceOnce,
	tooMany,
	type Undone,
} from "./index.ts";

type Content = Pick<Memory, "description" | "body">;

/**
 * A User's Memories kept in memory, by path, with the same limits, errors and undo as `memoriesOf` and `undoChange`
 * (a contract test runs both through the same scenarios); `grep` uses JavaScript's regular expressions rather than Postgres's.
 */
export function inMemoryMemories(
	seed: Pick<Memory, "path" | "description" | "body">[] = [],
	conversationId = "memory",
) {
	const store = new Map<string, Memory>();
	const changes = new Map<
		string,
		{ path: string; before?: Memory; after?: Content; undone?: boolean }
	>();
	const put = (
		m: Pick<Memory, "path" | "description" | "body">,
		by: string | null = conversationId,
	) => store.set(m.path, { ...m, conversationId: by, updatedAt: new Date() });
	for (const m of seed) put(m);
	const get = (path: string) => {
		const m = store.get(path);
		if (!m) throw missing(path);
		return m;
	};
	const record = (
		toolCallId: string | undefined,
		path: string,
		before: Memory | undefined,
		after: Content | undefined,
	) => {
		if (toolCallId) changes.set(toolCallId, { path, before, after });
	};
	// latest updated first: a Map keeps insertion order, and every write re-inserts
	const latest = () => [...store.values()].reverse();
	const memories: Memories = {
		index: async () =>
			latest().map(({ path, description }) => ({ path, description })),
		read: async (path) => store.get(path),
		write: async (path, description, body, toolCallId) => {
			checkMemory(path, description, body);
			const before = store.get(path);
			if (!before && store.size >= MAX_MEMORIES) throw tooMany();
			store.delete(path);
			put({ path, description, body });
			record(toolCallId, path, before, { description, body });
			return { before };
		},
		edit: async (path, old, replacement, toolCallId) => {
			const before = get(path);
			const body = replaceOnce(before.body, old, replacement);
			checkMemory(path, before.description, body);
			store.delete(path);
			put({ ...before, body });
			record(toolCallId, path, before, {
				description: before.description,
				body,
			});
			return { before };
		},
		delete: async (path, toolCallId) => {
			const before = get(path);
			store.delete(path);
			record(toolCallId, path, before, undefined);
			return { before };
		},
		grep: async (pattern) => {
			let re: RegExp;
			try {
				re = new RegExp(pattern, "i");
			} catch (error) {
				throw new InvalidMemory(
					`Invalid regular expression: ${(error as Error).message}`,
				);
			}
			return latest()
				.filter((m) => [m.path, m.description, m.body].some((s) => re.test(s)))
				.slice(0, MAX_GREP_RESULTS);
		},
	};
	/** As `undoChange`, for this Conversation's Tool calls. */
	const undo = async (toolCallId: string): Promise<Undone | undefined> => {
		const change = changes.get(toolCallId);
		if (!change) return "not_found";
		if (change.undone) return "undone";
		const { path, before, after } = change;
		const now = store.get(path);
		const same = after
			? now?.description === after.description && now.body === after.body
			: !now;
		if (!same) return "changed";
		store.delete(path);
		if (before) {
			if (!now && store.size >= MAX_MEMORIES) return "full";
			put(before, before.conversationId);
		}
		change.undone = true;
	};
	return { memories, store, undo };
}
