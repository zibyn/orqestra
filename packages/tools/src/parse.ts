import { setTimeout as sleep } from "node:timers/promises";
import { inflateRawSync } from "node:zlib";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { McpFetch } from "@earendil-works/pi-mcp";
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
type Fetch = McpFetch;

/** A MinerU error the Agent is told in plain words. */
class MinerUError extends Error {
	override name = "MinerUError";
}

/** What one of MinerU's error codes means, in plain words; MinerU's own message otherwise. */
function explain(code: unknown, msg: string, totalPages?: number) {
	if (code === -60006)
		return new MinerUError(
			`The document has too many pages for MinerU to parse at once (at most 200)${totalPages ? `: it has ${totalPages}` : ""}. Call parse again with \`pages\`, at most 200 of them at a time, e.g. "1-200".`,
		);
	if (code === -60018)
		return new MinerUError(
			"MinerU's daily parsing quota is used up; try again tomorrow.",
		);
	if (code === "A0202" || code === "A0211")
		return new MinerUError(
			"MinerU refused the Document Parser's key (invalid or expired); an Admin must enter a new one in the console.",
		);
	return new MinerUError(`MinerU failed (${code}): ${msg}`);
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
	poll(id: string): Promise<string | undefined>;
}

type Call = (
	path: string,
	init?: { method?: string; body?: unknown },
) => Promise<Json>;

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
		const put = await fetch(data.file_urls[0], {
			method: "PUT",
			body: bytes,
			signal,
		});
		if (!put.ok)
			throw new MinerUError(
				`MinerU's upload answered ${put.status}: ${(await put.text()).slice(0, 500)}`,
			);
		return data.batch_id;
	},
	async poll(id) {
		const { data } = await call(`/api/v4/extract-results/batch/${id}`);
		const item = data.extract_result?.[0];
		if (item?.state === "done") return item.full_zip_url;
		if (item?.state === "failed") {
			// shortcut: the docs show no failed item, so -60006 is also looked for in err_msg; recheck once seen for real
			const code =
				item.err_code ??
				(/-60006|页数|pages/.test(item.err_msg ?? "") ? -60006 : "failed");
			throw explain(code, item.err_msg, item.extract_progress?.total_pages);
		}
		return undefined;
	},
});

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
	throw new MinerUError("MinerU's result has no full.md");
}

/** The MinerU client: one flow over the API `parser`'s address speaks. */
export function mineru(
	{ baseUrl, apiKey }: DocumentParser,
	fetch: Fetch,
	{ pollMs = 3000 }: { pollMs?: number } = {},
) {
	const base = baseUrl.replace(/\/+$/, "");
	const call =
		(signal: AbortSignal): Call =>
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
			let json: Json;
			try {
				json = JSON.parse(text);
			} catch {
				throw new MinerUError(
					`MinerU answered ${response.status}: ${text.slice(0, 500)}`,
				);
			}
			if (json.code !== 0 || !response.ok)
				throw explain(
					json.code ?? response.status,
					json.msg ?? text.slice(0, 500),
				);
			return json;
		};
	return {
		/** The file's Markdown (full.md), polling until MinerU is done or `signal` aborts. */
		async parse(
			file: { name: string; bytes: Uint8Array<ArrayBuffer>; pages?: string },
			signal: AbortSignal,
		) {
			// v4 only so far: self-hosted MinerU's v1 Tasks (#75) become a second Mapping, picked with isMineruNet
			const api = v4(call(signal), fetch, signal);
			const id = await api.start(file);
			let url = await api.poll(id);
			while (!url) {
				await sleep(pollMs, undefined, { signal });
				url = await api.poll(id);
			}
			const zip = await fetch(url, { signal });
			if (!zip.ok)
				throw new MinerUError(`MinerU's result answered ${zip.status}`);
			return zipEntry(
				new Uint8Array(await zip.arrayBuffer()),
				(path) => path === "full.md" || path.endsWith("/full.md"),
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

/** Checks the Document Parser's address and key within `timeoutMs`, asking for a batch that does not exist; never throws. */
export async function testDocumentParser(
	{ baseUrl, apiKey }: DocumentParser,
	{
		fetch = (i, o) => globalThis.fetch(i, o),
		timeoutMs = 15_000,
	}: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<DocumentParserTestResult> {
	try {
		// shortcut: v4's path only; self-hosted MinerU (v1, #75) needs its own
		const response = await fetch(
			`${baseUrl.replace(/\/+$/, "")}/api/v4/extract-results/batch/connection-test`,
			{
				headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		const text = await response.text();
		let json: Json;
		try {
			json = JSON.parse(text);
		} catch {}
		if (
			[401, 403].includes(response.status) ||
			["A0202", "A0211"].includes(json?.code)
		)
			return {
				ok: false,
				reason: "auth",
				detail: json?.msg ?? text.slice(0, 500),
			};
		// any answer of MinerU's, "no such batch" too, means the key was taken
		if (json?.code === undefined)
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
					'Which pages to parse, e.g. "1-50" or "2,4-6"; all by default. Needed for documents over 200 pages',
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
