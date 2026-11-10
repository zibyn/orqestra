import { describe, expect, it } from "vitest";
// the zip writer the Skill upload tests use, independent of the reader under test
import { zip } from "../../config/src/test-zip.ts";
import {
	type DocumentParser,
	openToolbox,
	type ParseFiles,
	testDocumentParser,
} from "./index.ts";
import { memoryStore } from "./testing.ts";

const mineru: DocumentParser = {
	baseUrl: "https://mineru.net",
	apiKey: "k",
};
const never = new AbortController().signal;

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

/** A Run's Attachments in memory, and what Parse wrote into its Sandbox. */
function files(names: Record<string, Uint8Array> = { "report.pdf": pdf }) {
	const { store, objects } = memoryStore();
	for (const [name, bytes] of Object.entries(names))
		objects.set(`root/conv/${name}-key`, new Uint8Array(bytes));
	const sandbox = new Map<string, string>();
	const parseFiles: ParseFiles = {
		store,
		attachment: async (name) =>
			name in names ? { key: `root/conv/${name}-key` } : undefined,
		toSandbox: async (path, markdown) => {
			sandbox.set(path, markdown);
		},
	};
	return { files: parseFiles, objects, sandbox };
}

/** Opens a Toolbox with Parse served by `service` and returns the Parse Tool. */
async function parseTool(
	fetch: ReturnType<typeof fakeMineru>["fetch"],
	parseFiles?: ParseFiles,
	service: DocumentParser | undefined = mineru,
) {
	const box = await openToolbox(
		{ tools: service ? { parse: service } : {}, mcpServers: {} },
		["parse"],
		{ signal: never, fetch, files: parseFiles, pollMs: 1 },
	);
	return box.tools.find((t) => t.name === "parse");
}

/** Calls Parse and returns its text. */
async function parse(
	fetch: ReturnType<typeof fakeMineru>["fetch"],
	parseFiles: ParseFiles,
	params: Record<string, unknown>,
) {
	const tool = await parseTool(fetch, parseFiles);
	if (!tool) throw new Error("no parse Tool");
	const result = await tool.execute("1", params as never, never);
	const [content] = result.content;
	return content.type === "text" ? content.text : "";
}

describe("parse through mineru.net (v4)", () => {
	it("uploads the Attachment, polls until done and returns full.md", async () => {
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
		const run = files();
		expect(await parse(mineru.fetch, run.files, { name: "report.pdf" })).toBe(
			"# Report\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[Characters 0 to 39 of 39.]",
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
});

describe("parse", () => {
	it("passes `pages` through and writes that range's Markdown into the Sandbox", async () => {
		const mineru = fakeMineru({ markdown: "# Pages 2, 4 to 6" });
		const run = files();
		await parse(mineru.fetch, run.files, {
			name: "report.pdf",
			pages: "2, 4-6",
		});
		expect(mineru.requests[0].body).toMatchObject({
			files: [{ name: "report.pdf", page_ranges: "2,4-6" }],
		});
		expect(run.sandbox).toEqual(
			new Map([["uploads/report.pdf.2,4-6.md", "# Pages 2, 4 to 6"]]),
		);
	});

	it("returns the Markdown a page at a time, without MinerU's image links, the whole of it in the Sandbox", async () => {
		const markdown = `# Report\n![](images/a.jpg)\n${"x".repeat(100)}`;
		const run = files();
		const mineru = fakeMineru({ markdown });
		const page = await parse(mineru.fetch, run.files, {
			name: "report.pdf",
			offset: 9,
			limit: 10,
		});
		expect(page).toBe(
			"xxxxxxxxxx\n\n[Characters 9 to 19 of 109; read on with offset 19.]",
		);
		expect(run.sandbox.get("uploads/report.pdf.md")).toBe(
			`# Report\n${"x".repeat(100)}`,
		);
	});

	it("reads a range parsed before from the cache, not MinerU", async () => {
		const run = files();
		await parse(fakeMineru().fetch, run.files, { name: "report.pdf" });
		const again = fakeMineru({ markdown: "# Parsed again" });
		expect(await parse(again.fetch, run.files, { name: "report.pdf" })).toBe(
			"# Report\n\n[Characters 0 to 8 of 8.]",
		);
		expect(again.requests).toEqual([]);
		// another range is parsed
		await parse(again.fetch, run.files, { name: "report.pdf", pages: "1" });
		expect(again.requests).not.toEqual([]);
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
		await expect(
			parse(mineru.fetch, files().files, { name: "report.pdf" }),
		).rejects.toThrow(/too many pages.*it has 312.*`pages`/);
	});

	it("puts MinerU's quota and other errors in plain words", async () => {
		const quota = fakeMineru({
			upload: { body: { code: -60018, msg: "每日解析任务数量已达上限" } },
		});
		await expect(
			parse(quota.fetch, files().files, { name: "report.pdf" }),
		).rejects.toThrow("MinerU's daily parsing quota is used up");
		const key = fakeMineru({
			upload: { status: 401, body: { code: "A0202", msg: "Token 错误" } },
		});
		await expect(
			parse(key.fetch, files().files, { name: "report.pdf" }),
		).rejects.toThrow(/refused the Document Parser's key/);
		const failed = fakeMineru({
			polls: [state({ state: "failed", err_msg: "文件读取失败" })],
		});
		await expect(
			parse(failed.fetch, files().files, { name: "report.pdf" }),
		).rejects.toThrow("MinerU failed (failed): 文件读取失败");
	});

	it("refuses a type MinerU cannot read, and a name that is no Attachment", async () => {
		const mineru = fakeMineru();
		const run = files({ "notes.txt": pdf });
		await expect(
			parse(mineru.fetch, run.files, { name: "notes.txt" }),
		).rejects.toThrow(/Parse reads only PDF.*notes.txt is none of them/);
		await expect(
			parse(mineru.fetch, run.files, { name: "other.pdf" }),
		).rejects.toThrow("There is no attachment named other.pdf.");
		expect(mineru.requests).toEqual([]);
	});

	it("stops polling when the Run is stopped", async () => {
		const mineru = fakeMineru({ polls: [state({ state: "running" })] });
		const tool = await parseTool(mineru.fetch, files().files);
		const stop = new AbortController();
		const parsing = tool?.execute(
			"1",
			{ name: "report.pdf" } as never,
			stop.signal,
		);
		await new Promise((r) => setTimeout(r, 20));
		stop.abort();
		await expect(parsing).rejects.toThrow();
		const polled = mineru.polls();
		await new Promise((r) => setTimeout(r, 20));
		expect(mineru.polls()).toBe(polled);
	});

	it("is unavailable without a Document Parser, or without the Run's Attachments", async () => {
		const { fetch } = fakeMineru();
		expect(
			await parseTool(fetch, files().files, null as never),
		).toBeUndefined();
		expect(await parseTool(fetch, undefined)).toBeUndefined();
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
});
