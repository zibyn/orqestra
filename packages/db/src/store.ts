// Object storage, required like Postgres: Attachments' originals (ADR 0007), keyed under their top-level Conversation's id,
// and Skill files (ADR 0017), keyed under their Skill's name.

/** S3-compatible object storage; `s3Store` (in @orqestra/tools/s3) speaks to the real one, `memoryStore` keeps objects in memory. */
export interface ObjectStore {
	/** Writes `body` at `key`; one that fails midway leaves nothing. */
	put(
		key: string,
		body: ReadableStream<Uint8Array>,
		options?: { signal?: AbortSignal },
	): Promise<void>;
	/** The object's bytes as they arrive, and its size; undefined when there is none. */
	get(
		key: string,
	): Promise<{ body: ReadableStream<Uint8Array>; size: number } | undefined>;
	/** Deletes every object whose key starts with `prefix`. */
	deletePrefix(prefix: string): Promise<void>;
}

/** Object storage kept in memory, by key, for tests; `objects` shows what it holds. */
export function memoryStore() {
	const objects = new Map<string, Uint8Array<ArrayBuffer>>();
	const store: ObjectStore = {
		put: async (key, body) => {
			// a stream that fails midway stores nothing
			objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
		},
		get: async (key) => {
			const bytes = objects.get(key);
			return (
				bytes && {
					body: new Response(bytes).body as ReadableStream<Uint8Array>,
					size: bytes.length,
				}
			);
		},
		deletePrefix: async (prefix) => {
			for (const key of objects.keys())
				if (key.startsWith(prefix)) objects.delete(key);
		},
	};
	return { store, objects };
}
