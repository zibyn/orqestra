import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ObjectStore } from "@orqestra/db/store";
import type { ParserClient } from "@orqestra/integrations";

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

const text = (t: string) => [{ type: "text" as const, text: t }];
const pageRanges = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

/** The Parse Tool, served by `client`. */
export function parseTool(client: ParserClient, files: ParseFiles) {
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
