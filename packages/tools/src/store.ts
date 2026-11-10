// Object storage, where Orqestra keeps Attachments' originals (ADR 0007); keys start with their top-level Conversation's id.

/** S3-compatible object storage; `s3Store` (in `./s3`) speaks to the real one, `memoryStore` (in `./testing`) keeps objects in memory. */
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
