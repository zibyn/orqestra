// Bun's S3 client: only the api and worker, which run on Bun, import this.
import { S3Client } from "bun";
import type { ObjectStore } from "./store.ts";

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
		async put(key, body) {
			try {
				await s3.write(key, new Response(body));
			} catch (error) {
				// a multipart upload that failed may have left an object
				await s3.delete(key).catch(() => {});
				throw error;
			}
		},
		async get(key) {
			const file = s3.file(key);
			if (!(await file.exists())) return undefined;
			return { body: file.stream(), size: (await file.stat()).size };
		},
		async deletePrefix(prefix) {
			for (;;) {
				const page = await s3.list({ prefix });
				await Promise.all(
					(page.contents ?? []).map(({ key }) => s3.delete(key)),
				);
				if (!page.isTruncated) return;
			}
		},
	};
}
