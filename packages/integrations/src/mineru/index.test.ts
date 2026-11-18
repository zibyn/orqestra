import { describe, expect, it } from "vitest";
// the zip writer the Skill upload tests use, independent of the reader under test
import { zip } from "../../../skills/src/test-zip.ts";
import { mineru as client, testDocumentParser } from "./index.ts";

const mineru = {
	baseUrl: "https://mineru.net",
	apiKey: "k",
};
const never = new AbortController().signal;

type Fetch = ReturnType<typeof fakeMineru>["fetch"];
type Answer = { status?: number; body: unknown };
type Request = {
	method: string;
	url: string;
	auth: string | null;
	type: string | null;
	body: unknown;
};

/**
 * A fake mineru.net: the batch and upload calls answer `upload`, each poll answers the next of `polls`,
 * and the result zip holds `markdown` as full.md. Records the requests.
 */
function fakeMineru({
	markdown = "# Report",
	upload = {
		body: {
			code: 0,
			msg: "ok",
			data: { batch_id: "b1", file_urls: ["https://oss.example/u1?sig=1"] },
		},
	},
	polls = [done],
}: {
	markdown?: string;
	upload?: Answer;
	polls?: Answer[];
} = {}) {
	const requests: Request[] = [];
	let polled = 0;
	const fetch = async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		const raw = init?.body;
		requests.push({
			method: init?.method ?? "GET",
			url,
			auth: headers.get("authorization"),
			type: headers.get("content-type"),
			body:
				typeof raw === "string"
					? JSON.parse(raw)
					: raw && new Uint8Array(await new Response(raw).arrayBuffer()),
		});
		const json = ({ status = 200, body }: Answer) =>
			new Response(JSON.stringify(body), { status });
		if (url.endsWith("/api/v4/file-urls/batch")) return json(upload);
		if (url.startsWith("https://oss.example/u1")) return new Response(null);
		if (url.includes("/api/v4/extract-results/batch/"))
			return json(polls[Math.min(polled++, polls.length - 1)]);
		if (url === "https://cdn.example/r.zip")
			return new Response(
				zip([
					{ path: "full.md", content: markdown },
					{ path: "images/a.jpg", content: "jpg" },
				]),
			);
		return new Response("not found", { status: 404 });
	};
	return { fetch, requests, polls: () => polled };
}

const done: Answer = {
	body: {
		code: 0,
		data: {
			batch_id: "b1",
			extract_result: [
				{
					file_name: "report.pdf",
					state: "done",
					err_msg: "",
					full_zip_url: "https://cdn.example/r.zip",
				},
			],
		},
	},
};
const state = (item: object): Answer => ({
	body: {
		code: 0,
		data: {
			batch_id: "b1",
			extract_result: [{ file_name: "report.pdf", err_msg: "", ...item }],
		},
	},
});

const pdf = new TextEncoder().encode("%PDF-1.7 report");
const threePages = new TextEncoder().encode(
	"%PDF-1.7\n1 0 obj <</Type /Pages /Count 3>>\n2 0 obj <</Type /Page>>\n3 0 obj <</Type/Page>>\n4 0 obj <</Type /Page /Parent 1 0 R>>",
);

const selfHosted = {
	baseUrl: "http://mineru.lan:8000/",
	apiKey: "k",
};

/**
 * A fake self-hosted MinerU (v1 Tasks, 4.1): `POST /v1/tasks` answers `created`, each poll the next of `polls`,
 * `/v1/usage` has `maxPages`; the result redirects to object storage, a zip with `markdown` as markdown.md. Records the requests.
 */
function fakeMineruV1({
	markdown = "# Report",
	created = {
		status: 202,
		body: {
			task_id: "t1",
			status: "waiting-file",
			files: [
				{
					file_id: "f1",
					file_name: "report.pdf",
					status: "waiting-file",
					upload: {
						url: "http://mineru.lan:8000/v1/tasks/t1/uploads/f1",
						headers: { "Content-Type": "application/octet-stream" },
						expires_at: 1792731600,
					},
				},
			],
		},
	},
	polls = [completed],
	maxPages = null,
}: {
	markdown?: string;
	created?: Answer;
	polls?: Answer[];
	maxPages?: number | null;
} = {}) {
	const requests: Request[] = [];
	let polled = 0;
	const fetch = async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		const raw = init?.body;
		requests.push({
			method: init?.method ?? "GET",
			url,
			auth: headers.get("authorization"),
			type: headers.get("content-type"),
			body:
				typeof raw === "string"
					? JSON.parse(raw)
					: raw && new Uint8Array(await new Response(raw).arrayBuffer()),
		});
		const json = ({ status = 200, body }: Answer) =>
			new Response(JSON.stringify(body), { status });
		const base = "http://mineru.lan:8000";
		if (url === `${base}/v1/usage`)
			return json({
				body: {
					object: "usage",
					limits: { max_pages_per_file: maxPages, max_files_per_job: 100 },
				},
			});
		if (url === `${base}/v1/tasks`) return json(created);
		if (url === `${base}/v1/tasks/t1/uploads/f1`)
			return json({
				body: { task_id: "t1", file_id: "f1", status: "pending" },
			});
		if (url === `${base}/v1/tasks/t1`)
			return json(polls[Math.min(polled++, polls.length - 1)]);
		if (url === `${base}/v1/files/f1/content`)
			return new Response(null, {
				status: 302,
				headers: { location: "https://oss.example/r.zip?sig=2" },
			});
		if (url === "https://oss.example/r.zip?sig=2")
			return new Response(
				zip([
					{ path: "markdown.md", content: markdown },
					{ path: "middle_json.json", content: "{}" },
				]),
			);
		return new Response("not found", { status: 404 });
	};
	return { fetch, requests };
}

const task = (file: object, status = "running"): Answer => ({
	body: {
		task_id: "t1",
		status,
		created_at: "2026-11-10T04:00:00Z",
		output_formats: ["default"],
		progress: { completed: 0, failed: 0, total: 1 },
		files: [{ file_id: "f1", file_name: "report.pdf", bytes: 15, ...file }],
	},
});
// a relative result_url, resolved against the address
const completed = task(
	{
		status: "completed",
		parse: { tier: "standard" },
		result_url: "/v1/files/f1/content",
	},
	"completed",
);

/** Parses `file` through the MinerU at `service`, polling every millisecond. */
const parse = (
	fetch: Fetch,
	file: { name: string; bytes: Uint8Array<ArrayBuffer>; pages?: string },
	service = mineru,
	signal = never,
) => client(service, fetch, { pollMs: 1 }).parse(file, signal);

const report = { name: "report.pdf", bytes: pdf };

describe("parse through mineru.net (v4)", () => {
	it("uploads the file, polls until done and returns full.md", async () => {
		const mineru = fakeMineru({
			markdown: "# Report\n\n| a | b |\n|---|---|\n| 1 | 2 |",
			polls: [
				state({ state: "pending" }),
				state({
					state: "running",
					extract_progress: { extracted_pages: 1, total_pages: 2 },
				}),
				done,
			],
		});
		expect(await parse(mineru.fetch, report)).toBe(
			"# Report\n\n| a | b |\n|---|---|\n| 1 | 2 |",
		);
		const [batch, put, ...rest] = mineru.requests;
		expect(batch).toEqual({
			method: "POST",
			url: "https://mineru.net/api/v4/file-urls/batch",
			auth: "Bearer k",
			type: "application/json",
			body: {
				files: [{ name: "report.pdf" }],
				model_version: "vlm",
				language: "ch",
			},
		});
		// mineru.net's signed upload URL refuses a Content-Type
		expect(put).toEqual({
			method: "PUT",
			url: "https://oss.example/u1?sig=1",
			auth: null,
			type: null,
			body: pdf,
		});
		expect(rest.map((r) => `${r.method} ${r.url} ${r.auth}`)).toEqual([
			"GET https://mineru.net/api/v4/extract-results/batch/b1 Bearer k",
			"GET https://mineru.net/api/v4/extract-results/batch/b1 Bearer k",
			"GET https://mineru.net/api/v4/extract-results/batch/b1 Bearer k",
			"GET https://cdn.example/r.zip null",
		]);
	});

	it("passes `pages` as the file's page_ranges", async () => {
		const mineru = fakeMineru({ markdown: "# Pages 2, 4 to 6" });
		expect(await parse(mineru.fetch, { ...report, pages: "2,4-6" })).toBe(
			"# Pages 2, 4 to 6",
		);
		expect(mineru.requests[0].body).toMatchObject({
			files: [{ name: "report.pdf", page_ranges: "2,4-6" }],
		});
	});

	it("tells the Agent the document's pages and to pass `pages` when it is over MinerU's page limit", async () => {
		const mineru = fakeMineru({
			polls: [
				state({
					state: "failed",
					err_msg: "文件页数超过限制",
					extract_progress: { extracted_pages: 0, total_pages: 312 },
				}),
			],
		});
		await expect(parse(mineru.fetch, report)).rejects.toThrow(
			/too many pages.*it has 312.*`pages`/,
		);
		// without MinerU's count, a PDF's own
		const uncounted = fakeMineru({
			polls: [state({ state: "failed", err_msg: "文件页数超过限制" })],
		});
		await expect(
			parse(uncounted.fetch, { name: "report.pdf", bytes: threePages }),
		).rejects.toThrow(/too many pages.*at most 200.*it has 3/);
	});

	it("puts MinerU's quota and other errors in plain words", async () => {
		const quota = fakeMineru({
			upload: { body: { code: -60018, msg: "每日解析任务数量已达上限" } },
		});
		await expect(parse(quota.fetch, report)).rejects.toThrow(
			"MinerU's daily parsing quota is used up",
		);
		const key = fakeMineru({
			upload: { status: 401, body: { code: "A0202", msg: "Token 错误" } },
		});
		await expect(parse(key.fetch, report)).rejects.toThrow(
			/refused the Document Parser's key/,
		);
		const failed = fakeMineru({
			polls: [state({ state: "failed", err_msg: "文件读取失败" })],
		});
		await expect(parse(failed.fetch, report)).rejects.toThrow(
			"MinerU failed (failed): 文件读取失败",
		);
	});

	it("stops polling when `signal` aborts", async () => {
		const mineru = fakeMineru({ polls: [state({ state: "running" })] });
		const stop = new AbortController();
		const parsing = parse(mineru.fetch, report, undefined, stop.signal);
		await new Promise((r) => setTimeout(r, 20));
		stop.abort();
		await expect(parsing).rejects.toThrow();
		const polled = mineru.polls();
		await new Promise((r) => setTimeout(r, 20));
		expect(mineru.polls()).toBe(polled);
	});
});

describe("parse through a self-hosted MinerU (v1 Tasks)", () => {
	it("creates a Task, PUTs the file where it says, polls and returns markdown.md from the redirected result", async () => {
		const v1 = fakeMineruV1({
			markdown: "# Report\n\nself-hosted",
			polls: [
				task({ status: "pending" }, "pending"),
				task({ status: "running" }),
				completed,
			],
		});
		expect(await parse(v1.fetch, report, selfHosted)).toBe(
			"# Report\n\nself-hosted",
		);
		const [usage, create, put, ...rest] = v1.requests;
		expect(usage).toMatchObject({
			method: "GET",
			url: "http://mineru.lan:8000/v1/usage",
			auth: "Bearer k",
		});
		expect(create).toEqual({
			method: "POST",
			url: "http://mineru.lan:8000/v1/tasks",
			auth: "Bearer k",
			type: "application/json",
			body: {
				files: [{ file_name: "report.pdf", bytes: pdf.byteLength }],
				ocr_mode: "auto",
			},
		});
		expect(put).toEqual({
			method: "PUT",
			url: "http://mineru.lan:8000/v1/tasks/t1/uploads/f1",
			auth: "Bearer k",
			type: "application/octet-stream",
			body: pdf,
		});
		// the key goes to MinerU's own origin only, not to the storage it redirects to
		expect(rest.map((r) => `${r.method} ${r.url} ${r.auth}`)).toEqual([
			"GET http://mineru.lan:8000/v1/tasks/t1 Bearer k",
			"GET http://mineru.lan:8000/v1/tasks/t1 Bearer k",
			"GET http://mineru.lan:8000/v1/tasks/t1 Bearer k",
			"GET http://mineru.lan:8000/v1/files/f1/content Bearer k",
			"GET https://oss.example/r.zip?sig=2 null",
		]);
	});

	it("tells the Agent the document's pages and to pass `pages` when it is over /v1/usage's page limit", async () => {
		const limited = fakeMineruV1({ maxPages: 2 });
		const file = { name: "report.pdf", bytes: threePages };
		await expect(parse(limited.fetch, file, selfHosted)).rejects.toThrow(
			/too many pages.*at most 2.*it has 3.*`pages`.*"1-2"/,
		);
		expect(limited.requests.map((r) => r.url)).toEqual([
			"http://mineru.lan:8000/v1/usage",
		]);
		// a range is MinerU's to check
		await parse(limited.fetch, { ...file, pages: "1-2" }, selfHosted);
		expect(limited.requests[2].body).toMatchObject({ page_range: "1-2" });
		// null is no limit
		const unlimited = fakeMineruV1();
		await parse(unlimited.fetch, { ...file, pages: "2,3" }, selfHosted);
		expect(unlimited.requests[1].body).toMatchObject({ page_range: "2,3" });
	});

	it("sends no Authorization without a key", async () => {
		const v1 = fakeMineruV1();
		await parse(v1.fetch, report, { ...selfHosted, apiKey: "" });
		expect(v1.requests).toHaveLength(6);
		expect(v1.requests.map((r) => r.auth)).toEqual(v1.requests.map(() => null));
	});

	it("says why a file failed or was canceled, and a refused key in plain words", async () => {
		const failed = fakeMineruV1({
			polls: [
				task(
					{
						status: "failed",
						error: { code: "parse_failed", message: "PDF 无法打开" },
					},
					"failed",
				),
			],
		});
		await expect(parse(failed.fetch, report, selfHosted)).rejects.toThrow(
			"MinerU failed (parse_failed): PDF 无法打开",
		);
		const canceled = fakeMineruV1({
			polls: [task({ status: "canceled" }, "canceled")],
		});
		await expect(parse(canceled.fetch, report, selfHosted)).rejects.toThrow(
			"MinerU failed (canceled)",
		);
		// the Task ended while its file's status lags behind
		const ended = fakeMineruV1({
			polls: [task({ status: "running" }, "failed")],
		});
		await expect(parse(ended.fetch, report, selfHosted)).rejects.toThrow(
			"MinerU failed (failed)",
		);
		const refused = fakeMineruV1({
			created: {
				status: 401,
				body: {
					error: { code: "invalid_api_key", message: "Invalid API key" },
				},
			},
		});
		await expect(parse(refused.fetch, report, selfHosted)).rejects.toThrow(
			/refused the Document Parser's key/,
		);
		const invalid = fakeMineruV1({
			created: {
				status: 400,
				body: {
					error: {
						code: "page_range_invalid",
						message: "page_range is not allowed for docx",
						param: "files.0.page_range",
					},
				},
			},
		});
		await expect(parse(invalid.fetch, report, selfHosted)).rejects.toThrow(
			"MinerU failed (page_range_invalid): page_range is not allowed for docx",
		);
	});
});

describe("testDocumentParser", () => {
	const answering =
		(status: number, body: unknown) => async (url: string | URL) => {
			expect(String(url)).toMatch(
				/^https:\/\/mineru\.net\/api\/v4\/extract-results\/batch\//,
			);
			return new Response(JSON.stringify(body), { status });
		};

	it("passes when mineru.net takes the key, even for a batch it does not know", async () => {
		expect(
			await testDocumentParser(mineru, {
				fetch: answering(200, { code: -60012, msg: "任务不存在" }),
			}),
		).toEqual({ ok: true });
	});

	it("tells a refused key from an unreachable address", async () => {
		expect(
			await testDocumentParser(mineru, {
				fetch: answering(401, { code: "A0202", msg: "Token 错误" }),
			}),
		).toMatchObject({ ok: false, reason: "auth" });
		expect(
			await testDocumentParser(
				{ baseUrl: "http://127.0.0.1:9", apiKey: "k" },
				{},
			),
		).toMatchObject({ ok: false, reason: "unreachable" });
	});

	it("asks a self-hosted MinerU for its /v1/usage", async () => {
		const usage =
			(status: number, body: unknown) => async (url: string | URL) => {
				expect(String(url)).toBe("http://mineru.lan:8000/v1/usage");
				return new Response(JSON.stringify(body), { status });
			};
		expect(
			await testDocumentParser(selfHosted, {
				fetch: usage(200, {
					object: "usage",
					limits: { max_pages_per_file: null },
				}),
			}),
		).toEqual({ ok: true });
		expect(
			await testDocumentParser(selfHosted, {
				fetch: usage(401, {
					error: { code: "invalid_api_key", message: "Invalid API key" },
				}),
			}),
		).toEqual({ ok: false, reason: "auth", detail: "Invalid API key" });
		// another server at that address
		expect(
			await testDocumentParser(selfHosted, {
				fetch: usage(404, { detail: "Not Found" }),
			}),
		).toMatchObject({ ok: false, reason: "failed" });
	});
});
