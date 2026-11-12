import { setTimeout as sleep } from "node:timers/promises";
import { inflateRawSync } from "node:zlib";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Fetch } from "./index.ts";
import { isMineruNet } from "./shared.ts";
import type { ObjectStore } from "./store.ts";

// Parse: an Attachment turned into Markdown by the Document Parser (MinerU), cached in object storage per page range.

/** The Document Parser (MinerU) and its decrypted key; "" when none is set (a self-hosted MinerU). */
export interface DocumentParser {
	baseUrl: string;
	apiKey: string;
}

/** What Parse reads and writes for one Run. */
export interface ParseFiles {
	/** The Attachment `name` of the Run's Conversation, or of the Conversation that started it; undefined when there is none. */
	attachment(name: string): Promise<{ key: string } | undefined>;
	store: ObjectStore;
	/** Writes a file into the Run's Sandbox at /workspace/<path>; none without a Sandbox Provider. */
	toSandbox?(path: string, markdown: string): Promise<void>;
}

const TYPES = [
	"pdf",
	...["png", "jpg", "jpeg", "jp2", "webp", "gif", "bmp"],
	...["doc", "docx", "ppt", "pptx", "xls", "xlsx"],
];
/** Characters of Markdown one call returns by default. */
const PAGE_CHARS = 50_000;

// biome-ignore lint/suspicious/noExplicitAny: MinerU's JSON, read field by field
type Json = any;

/** mineru.net's page limit per file: "文件页数不超出 200 页" (https://mineru.net/apiManage/docs). */
const MINERU_NET_MAX_PAGES = 200;
/** mineru.net's codes for a refused key. */
const KEY_REFUSED = ["A0202", "A0211"];

/** A MinerU error the Agent is told in plain words. */
class MinerUError extends Error {
	override name = "MinerUError";
}

/** What one of MinerU's error codes means, in plain words; MinerU's own message otherwise. */
function explain(
	code: unknown,
	msg: string,
	totalPages?: number,
	maxPages = MINERU_NET_MAX_PAGES,
) {
	if (code === -60006)
		return new MinerUError(
			`The document has too many pages for MinerU to parse at once (at most ${maxPages})${totalPages ? `: it has ${totalPages}` : ""}. Call parse again with \`pages\`, at most ${maxPages} of them at a time, e.g. "1-${maxPages}".`,
		);
	if (code === -60018)
		return new MinerUError(
			"MinerU's daily parsing quota is used up; try again tomorrow.",
		);
	// mineru.net's codes, then v1's
	if (KEY_REFUSED.includes(code as string) || code === "invalid_api_key")
		return new MinerUError(
			"MinerU refused the Document Parser's key (invalid or expired); an Admin must enter a new one in the console.",
		);
	return new MinerUError(`MinerU failed (${code}): ${msg}`);
}

/** MinerU's JSON, undefined when `text` is not JSON. */
function jsonOf(text: string): Json {
	try {
		return JSON.parse(text);
	} catch {}
}

/** Throws when the PUT of a file to where MinerU said failed. */
async function uploaded(put: Response) {
	if (!put.ok)
		throw new MinerUError(
			`MinerU's upload answered ${put.status}: ${(await put.text()).slice(0, 500)}`,
		);
}

/** One MinerU API: starts parsing a file and tells when its result zip is ready. */
interface Mapping {
	/** Uploads the file and starts parsing it; returns what `poll` takes. */
	start(file: {
		name: string;
		bytes: Uint8Array<ArrayBuffer>;
		pages?: string;
	}): Promise<string>;
	/** The result zip's URL once done, undefined while it is under way; throws why it failed. */
	poll(
		id: string,
		file: { name: string; bytes: Uint8Array },
	): Promise<string | undefined>;
}

type Call = (
	path: string,
	init?: { method?: string; body?: unknown },
) => Promise<Json>;
/** Throws what went wrong when an answer of MinerU's is not a success. */
type Check = (json: Json, response: Response, text: string) => void;

const v4Check: Check = (json, response, text) => {
	if (json.code !== 0 || !response.ok)
		throw explain(json.code ?? response.status, json.msg ?? text.slice(0, 500));
};
const v1Check: Check = (json, response, text) => {
	if (!response.ok)
		throw explain(
			json.error?.code ?? response.status,
			json.error?.message ?? text.slice(0, 500),
		);
};

/** mineru.net's precise parsing API (v4). */
const v4 = (call: Call, fetch: Fetch, signal: AbortSignal): Mapping => ({
	async start({ name, bytes, pages }) {
		const { data } = await call("/api/v4/file-urls/batch", {
			method: "POST",
			body: {
				files: [{ name, ...(pages ? { page_ranges: pages } : {}) }],
				model_version: "vlm",
				language: "ch",
			},
		});
		// the signed URL refuses a Content-Type; parsing starts once the upload is done
		await uploaded(
			await fetch(data.file_urls[0], { method: "PUT", body: bytes, signal }),
		);
		return data.batch_id;
	},
	async poll(id, file) {
		const { data } = await call(`/api/v4/extract-results/batch/${id}`);
		const item = data.extract_result?.[0];
		if (item?.state === "done") return item.full_zip_url;
		if (item?.state === "failed") {
			// shortcut: the docs show no failed item, so -60006 is also looked for in err_msg; recheck once seen for real
			const code =
				item.err_code ??
				(/-60006|页数|pages/.test(item.err_msg ?? "") ? -60006 : "failed");
			throw explain(
				code,
				item.err_msg,
				// the PDF's own count when MinerU does not say
				item.extract_progress?.total_pages || pdfPages(file.name, file.bytes),
			);
		}
		return undefined;
	},
});

/** Self-hosted MinerU's Tasks API (v1), as of MinerU 4.1. */
const v1 = (call: Call, fetch: Fetch, signal: AbortSignal): Mapping => ({
	async start({ name, bytes, pages }) {
		// v1 has no page-limit error of its own; a deployment states its limit, null for none
		const { limits } = await call("/v1/usage");
		const maxPages = limits?.max_pages_per_file;
		if (typeof maxPages === "number" && !pages) {
			const totalPages = pdfPages(name, bytes);
			if (totalPages > maxPages)
				throw explain(-60006, "", totalPages, maxPages);
		}
		const task = await call("/v1/tasks", {
			method: "POST",
			body: {
				files: [{ file_name: name, bytes: bytes.byteLength }],
				ocr_mode: "auto",
				...(pages ? { page_range: pages } : {}),
			},
		});
		// none when MinerU already holds these bytes
		const upload = task.files?.[0]?.upload;
		if (upload) {
			await uploaded(
				await fetch(upload.url, {
					method: "PUT",
					headers: upload.headers,
					body: bytes,
					signal,
				}),
			);
		}
		return task.task_id;
	},
	async poll(id) {
		const task = await call(`/v1/tasks/${encodeURIComponent(id)}`);
		const file = task.files?.[0];
		if (file?.status === "completed") return file.result_url;
		// an ended Task ends its file, whatever the file's status says yet
		if (
			[file?.status, task.status].some(
				(s) => s === "failed" || s === "canceled",
			)
		) {
			const error = file?.error ?? task.error;
			throw explain(error?.code ?? task.status, error?.message ?? "");
		}
		return undefined;
	},
});

/** A PDF's page count, 0 for any other file. */
function pdfPages(name: string, bytes: Uint8Array) {
	if (!name.toLowerCase().endsWith(".pdf")) return 0;
	// shortcut: counts page objects in the clear, so pages inside compressed object streams (PDF 1.5+) are missed and MinerU decides; use a PDF parser if a deployment's limit matters
	return (
		Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			.toString("latin1")
			.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0
	);
}

/** The first file of the zip whose path `wanted` accepts, as text; stored and deflated entries only, no zip64. */
function zipEntry(bytes: Uint8Array, wanted: (path: string) => boolean) {
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// the end record sits in the last 22 bytes plus a comment of up to 64 KiB
	let at = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
		if (buf.readUInt32LE(i) === 0x06054b50) {
			at = buf.readUInt32LE(i + 16);
			break;
		}
	while (
		at >= 0 &&
		at + 46 <= buf.length &&
		buf.readUInt32LE(at) === 0x02014b50
	) {
		const nameLength = buf.readUInt16LE(at + 28);
		const path = buf.toString("utf8", at + 46, at + 46 + nameLength);
		if (wanted(path)) {
			const method = buf.readUInt16LE(at + 10);
			const compressed = buf.readUInt32LE(at + 20);
			const local = buf.readUInt32LE(at + 42);
			const start =
				local +
				30 +
				buf.readUInt16LE(local + 26) +
				buf.readUInt16LE(local + 28);
			const data = buf.subarray(start, start + compressed);
			if (method === 0) return data.toString("utf8");
			if (method === 8) return inflateRawSync(data).toString("utf8");
			break;
		}
		at +=
			46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
	}
	throw new MinerUError("MinerU's result has no Markdown");
}

/** The MinerU client: one flow over the API `parser`'s address speaks. */
export function mineru(
	{ baseUrl, apiKey }: DocumentParser,
	fetch: Fetch,
	{ pollMs = 3000 }: { pollMs?: number } = {},
) {
	const base = baseUrl.replace(/\/+$/, "");
	const call =
		(signal: AbortSignal, check: Check): Call =>
		async (path, { method = "GET", body } = {}) => {
			const response = await fetch(`${base}${path}`, {
				method,
				headers: {
					...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
					...(body ? { "content-type": "application/json" } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				// a hung MinerU must not hold the Run until someone stops it
				signal: AbortSignal.any([AbortSignal.timeout(60_000), signal]),
			});
			const text = await response.text();
			const json = jsonOf(text);
			if (json === undefined)
				throw new MinerUError(
					`MinerU answered ${response.status}: ${text.slice(0, 500)}`,
				);
			check(json, response, text);
			return json;
		};
	const origin = URL.parse(base)?.origin;
	/** fetch for the URLs MinerU hands out: the key goes to the address's origin only, never to storage. */
	const handedOut: Fetch = (url, init) =>
		fetch(url, {
			...init,
			headers: {
				...(apiKey && new URL(url).origin === origin
					? { authorization: `Bearer ${apiKey}` }
					: {}),
				...(init?.headers as Record<string, string>),
			},
		});
	/** The result at `url`, relative to the address or not, redirects followed. */
	const download = async (url: string, signal: AbortSignal) => {
		let at = new URL(url, `${base}/`);
		for (let hop = 0; hop < 6; hop++) {
			const response = await handedOut(at, { redirect: "manual", signal });
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				at = new URL(location, at);
				continue;
			}
			if (!response.ok)
				throw new MinerUError(`MinerU's result answered ${response.status}`);
			return new Uint8Array(await response.arrayBuffer());
		}
		throw new MinerUError("MinerU's result redirected too many times");
	};
	return {
		/** The file's Markdown, polling until MinerU is done or `signal` aborts. */
		async parse(
			file: { name: string; bytes: Uint8Array<ArrayBuffer>; pages?: string },
			signal: AbortSignal,
		) {
			// shortcut: picked by host, so a reverse proxy in front of mineru.net speaks v1 and fails; add a protocol setting if one is needed
			const api = isMineruNet(base)
				? v4(call(signal, v4Check), handedOut, signal)
				: v1(call(signal, v1Check), handedOut, signal);
			const id = await api.start(file);
			let url = await api.poll(id, file);
			while (!url) {
				await sleep(pollMs, undefined, { signal });
				url = await api.poll(id, file);
			}
			// v4 names it full.md, v1 markdown.md
			return zipEntry(await download(url, signal), (path) =>
				/(^|\/)(full|markdown)\.md$/.test(path),
			);
		},
	};
}

export type DocumentParserTestResult =
	| { ok: true }
	| {
			ok: false;
			reason: "auth" | "unreachable" | "timeout" | "failed";
			detail: string;
	  };

/** Checks the Document Parser's address and key within `timeoutMs`, asking mineru.net for a batch that does not exist, a self-hosted MinerU for its usage; never throws. */
export async function testDocumentParser(
	{ baseUrl, apiKey }: DocumentParser,
	{
		fetch = (i, o) => globalThis.fetch(i, o),
		timeoutMs = 15_000,
	}: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<DocumentParserTestResult> {
	const v4 = isMineruNet(baseUrl);
	try {
		const response = await fetch(
			`${baseUrl.replace(/\/+$/, "")}${v4 ? "/api/v4/extract-results/batch/connection-test" : "/v1/usage"}`,
			{
				headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		const text = await response.text();
		const json = jsonOf(text);
		if (
			[401, 403].includes(response.status) ||
			KEY_REFUSED.includes(json?.code)
		)
			return {
				ok: false,
				reason: "auth",
				detail: json?.msg ?? json?.error?.message ?? text.slice(0, 500),
			};
		// any answer of mineru.net's, "no such batch" too, means the key was taken
		if (v4 ? json?.code === undefined : json?.object !== "usage")
			return {
				ok: false,
				reason: "failed",
				detail: `answered ${response.status}: ${text.slice(0, 500)}`,
			};
		return { ok: true };
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError")
			return { ok: false, reason: "timeout", detail: error.message };
		// fetch hides why it failed (ECONNREFUSED, ENOTFOUND) in its cause
		if (error instanceof TypeError)
			return {
				ok: false,
				reason: "unreachable",
				detail:
					error.cause instanceof Error
						? `${error.message}: ${error.cause.message}`
						: error.message,
			};
		return { ok: false, reason: "failed", detail: String(error) };
	}
}

const text = (t: string) => [{ type: "text" as const, text: t }];
const pageRanges = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

/** The Parse Tool, served by `parser`. */
export function parseTool(
	parser: DocumentParser,
	files: ParseFiles,
	fetch: Fetch,
	options: { pollMs?: number },
) {
	const client = mineru(parser, fetch, options);
	// the full Markdown goes into the Sandbox once per Run and page range
	const written = new Set<string>();
	const tool: AgentTool<ReturnType<typeof parameters>> = {
		name: "parse",
		label: "Parse",
		description: `Read an attached document (PDF, image, Word, PowerPoint or Excel) as Markdown, with its text, tables and formulas, a page of ${PAGE_CHARS} characters at a time. Returns that page and the Markdown's total length; read on with \`offset\`.`,
		parameters: parameters(),
		execute: async (
			_id,
			{ name, pages, offset = 0, limit = PAGE_CHARS },
			signal,
		) => {
			const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
			if (!name.includes(".") || !TYPES.includes(ext))
				throw new Error(
					`Parse reads only PDF, images (png, jpg, jpeg, jp2, webp, gif, bmp) and Office documents (doc, docx, ppt, pptx, xls, xlsx); ${name} is none of them.`,
				);
			const range = pages?.replace(/\s+/g, "") || undefined;
			if (range && !pageRanges.test(range))
				throw new Error(
					`pages must look like "1-10" or "2,4-6", not "${pages}"`,
				);
			const attachment = await files.attachment(name);
			if (!attachment) throw new Error(`There is no attachment named ${name}.`);
			// beside the original, so it is deleted with it
			const cacheKey = `${attachment.key}.parse/${range ?? "all"}.md`;
			const cached = await files.store.get(cacheKey);
			let markdown: string;
			if (cached) markdown = await new Response(cached.body).text();
			else {
				const original = await files.store.get(attachment.key);
				if (!original)
					throw new Error(`The attachment ${name} is missing from storage.`);
				const bytes = new Uint8Array(
					await new Response(original.body).arrayBuffer(),
				);
				markdown = (
					await client.parse(
						{ name, bytes, pages: range },
						signal ?? new AbortController().signal,
					)
				)
					// MinerU's extracted images are not kept
					.replace(/!\[[^\]]*\]\([^)]*\)\n?/g, "");
				await files.store.put(
					cacheKey,
					new Response(markdown).body as ReadableStream<Uint8Array>,
				);
			}
			if (files.toSandbox && !written.has(cacheKey)) {
				await files.toSandbox(
					`uploads/${name}${range ? `.${range}` : ""}.md`,
					markdown,
				);
				written.add(cacheKey);
			}
			const end = Math.min(offset + limit, markdown.length);
			return {
				content: text(
					`${markdown.slice(offset, end)}\n\n[Characters ${offset} to ${end} of ${markdown.length}${end < markdown.length ? `; read on with offset ${end}` : ""}.]`,
				),
				details: undefined,
			};
		},
	};
	return tool as unknown as AgentTool;
}

const parameters = () =>
	Type.Object({
		name: Type.String({ description: "The attachment's file name" }),
		pages: Type.Optional(
			Type.String({
				description:
					'Which pages to parse, e.g. "1-50" or "2,4-6"; all by default. Needed for documents over the page limit of MinerU',
			}),
		),
		offset: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Where in the Markdown to start, in characters; 0 by default",
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: PAGE_CHARS,
				description: `How many characters to return, ${PAGE_CHARS} by default`,
			}),
		),
	});
