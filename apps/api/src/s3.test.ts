import { afterAll, describe, expect, it } from "bun:test";
import { s3Store } from "@orqestra/integrations/s3";

// A stand-in S3 that takes single and multipart PUTs and records each request
const requests: string[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		await req.arrayBuffer();
		requests.push(`${req.method} ${url.pathname}`);
		// lists one object under mute/, and never answers its delete
		if (url.searchParams.get("prefix") === "mute/")
			return new Response(
				"<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>mute/k</Key></Contents></ListBucketResult>",
			);
		if (url.pathname === "/b/mute/k") return new Promise<Response>(() => {});
		// refuses every write under denied/, and never answers a delete
		if (url.pathname.startsWith("/b/denied/"))
			return req.method === "DELETE"
				? new Promise<Response>(() => {})
				: new Response("<Error><Code>AccessDenied</Code></Error>", {
						status: 403,
					});
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

	it("fails a write storage refused within a few seconds, though storage never answers its delete", async () => {
		const started = performance.now();
		await expect(
			store.put(
				"denied/k",
				new Response("hi").body as ReadableStream<Uint8Array>,
			),
		).rejects.toThrow();
		expect(performance.now() - started).toBeLessThan(3000);
		expect(requests.at(-1)).toBe("DELETE /b/denied/k");
	});

	it("deletes nothing after a failed write with keepOnFailure", async () => {
		await expect(
			store.put(
				"denied/kept",
				new Response("hi").body as ReadableStream<Uint8Array>,
				{ keepOnFailure: true },
			),
		).rejects.toThrow();
		expect(requests).not.toContain("DELETE /b/denied/kept");
		expect(requests.at(-1)).toMatch(/^(POST|PUT) \/b\/denied\/kept$/);
	});

	it("gives up deleting once the signal aborts, though storage never answers a delete", async () => {
		await expect(
			store.deletePrefix("mute/", { signal: AbortSignal.timeout(100) }),
		).rejects.toThrow(/timed out/);
		expect(requests.at(-1)).toBe("DELETE /b/mute/k");
	});

	it("gives up putting or deleting once the signal aborts, though storage never answers", async () => {
		const mute = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const silent = s3Store({
			S3_ENDPOINT: `http://127.0.0.1:${mute.port}`,
			S3_BUCKET: "b",
			S3_ACCESS_KEY_ID: "a",
			S3_SECRET_ACCESS_KEY: "s",
		});
		try {
			await expect(
				silent.put("k", new Response("hi").body as ReadableStream<Uint8Array>, {
					signal: AbortSignal.timeout(100),
				}),
			).rejects.toThrow(/timed out/);
			await expect(
				silent.deletePrefix("p/", { signal: AbortSignal.timeout(100) }),
			).rejects.toThrow(/timed out/);
		} finally {
			mute.stop(true);
		}
	});
});
