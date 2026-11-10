import { afterAll, describe, expect, it } from "bun:test";
import { s3Store } from "@orqestra/tools/s3";

// A stand-in S3 that takes single and multipart PUTs and records each request
const requests: string[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		await req.arrayBuffer();
		requests.push(`${req.method} ${url.pathname}`);
		if (url.searchParams.has("uploads"))
			return new Response(
				"<InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>",
			);
		if (url.searchParams.has("uploadId") && req.method === "POST")
			return new Response(
				"<CompleteMultipartUploadResult></CompleteMultipartUploadResult>",
			);
		return new Response("", { headers: { etag: '"e"' } });
	},
});
afterAll(() => server.stop(true));
const store = s3Store({
	S3_ENDPOINT: `http://localhost:${server.port}`,
	S3_BUCKET: "b",
	S3_ACCESS_KEY_ID: "a",
	S3_SECRET_ACCESS_KEY: "s",
	S3_REGION: "us-east-1",
});

describe("s3Store", () => {
	it("stops writing when the signal aborts, leaving nothing", async () => {
		const abort = new AbortController();
		let sent = 0;
		// 8 MB, slowly: the abort comes partway through
		const body = new ReadableStream<Uint8Array>({
			async pull(c) {
				if (sent === 128) return c.close();
				if (++sent === 20) abort.abort(new Error("gone"));
				c.enqueue(new Uint8Array(64 * 1024));
				await Bun.sleep(1);
			},
		});
		await expect(
			store.put("k", body, { signal: abort.signal }),
		).rejects.toThrow("gone");
		expect(sent).toBeLessThan(128);
		expect(requests.at(-1)).toBe("DELETE /b/k");
	});
});
