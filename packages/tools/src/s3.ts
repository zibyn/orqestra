// Bun's S3 client: only the api and worker, which run on Bun, import this.

import type { ObjectStore } from "@orqestra/db/store";
import { S3Client } from "bun";

const REQUIRED = [
	"S3_ENDPOINT",
	"S3_BUCKET",
	"S3_ACCESS_KEY_ID",
	"S3_SECRET_ACCESS_KEY",
] as const;

/**
 * The S3-compatible object storage (RustFS, MinIO, S3, R2…) that `env` names; S3_REGION is optional.
 * Throws, naming what is missing, so the api and worker do not start without it.
 */
export function s3Store(
	env: Record<string, string | undefined> = process.env,
): ObjectStore {
	const missing = REQUIRED.filter((name) => !env[name]);
	if (missing.length)
		throw new Error(
			`Object storage is not configured: set ${missing.join(", ")}`,
		);
	const s3 = new S3Client({
		endpoint: env.S3_ENDPOINT,
		bucket: env.S3_BUCKET,
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
		region: env.S3_REGION,
	});
	return {
		async put(key, body, { signal } = {}) {
			// a stream body goes up as a multipart upload, 5 MiB parts sent as they fill; the signal errors it
			const written = s3.write(
				key,
				new Response(body.pipeThrough(new TransformStream(), { signal })),
			);
			try {
				await Promise.race([written, untilAborted(signal)]);
			} catch (error) {
				// a multipart upload that failed may have left an object. None is deleted while storage has not answered
				// the write: the delete could land after a later put of the key
				const answered = await Promise.race([
					written.then(
						() => true,
						() => true,
					),
					Bun.sleep(1000).then(() => false),
				]);
				if (answered) await s3.delete(key).catch(() => {});
				throw error;
			}
		},
		async get(key) {
			const file = s3.file(key);
			if (!(await file.exists())) return undefined;
			return { body: file.stream(), size: (await file.stat()).size };
		},
		async deletePrefix(prefix, { signal } = {}) {
			const aborted = untilAborted(signal);
			for (;;) {
				const page = await Promise.race([s3.list({ prefix }), aborted]);
				// none sent once it aborts, as a delete could land after a later put of the key
				signal?.throwIfAborted();
				await Promise.race([
					Promise.all((page.contents ?? []).map(({ key }) => s3.delete(key))),
					aborted,
				]);
				if (!page.isTruncated) return;
			}
		},
	};
}

/** Rejects once `signal` aborts: Bun's client takes no signal, so storage that stops answering would keep it waiting however long. */
function untilAborted(signal?: AbortSignal) {
	const aborted = new Promise<never>((_, reject) => {
		if (signal?.aborted) reject(signal.reason);
		signal?.addEventListener("abort", () => reject(signal.reason));
	});
	aborted.catch(() => {});
	return aborted;
}
