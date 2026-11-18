import { memoryStore } from "@orqestra/db/store";
import type { ParserClient } from "@orqestra/integrations";
import { describe, expect, it } from "vitest";
import { builtinTools, type ParseFiles } from "./index.ts";
import { parseTool } from "./parse.ts";

const never = new AbortController().signal;
const pdf = new TextEncoder().encode("%PDF-1.7 report");

/** A Document Parser answering `markdown`; records each file it is asked to parse. */
function parser(markdown = "# Report") {
	const asked: { name: string; bytes: Uint8Array; pages?: string }[] = [];
	const client: ParserClient = {
		parse: async (file) => {
			asked.push(file);
			return markdown;
		},
	};
	return { client, asked };
}

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

/** Calls Parse, served by `client`, and returns its text. */
async function parse(
	client: ParserClient,
	parseFiles: ParseFiles,
	params: Record<string, unknown>,
	signal = never,
) {
	const result = await parseTool(client, parseFiles).execute(
		"1",
		params as never,
		signal,
	);
	const [content] = result.content;
	return content.type === "text" ? content.text : "";
}

describe("parse", () => {
	it("passes `pages` through and writes that range's Markdown into the Sandbox", async () => {
		const mineru = parser("# Pages 2, 4 to 6");
		const run = files();
		await parse(mineru.client, run.files, {
			name: "report.pdf",
			pages: "2, 4-6",
		});
		expect(mineru.asked).toEqual([
			{ name: "report.pdf", bytes: pdf, pages: "2,4-6" },
		]);
		expect(run.sandbox).toEqual(
			new Map([["uploads/report.pdf.2,4-6.md", "# Pages 2, 4 to 6"]]),
		);
	});

	it("returns the Markdown a page at a time, without MinerU's image links, the whole of it in the Sandbox", async () => {
		const markdown = `# Report\n![](images/a.jpg)\n${"x".repeat(100)}`;
		const run = files();
		const page = await parse(parser(markdown).client, run.files, {
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
		await parse(parser().client, run.files, { name: "report.pdf" });
		const again = parser("# Parsed again");
		expect(await parse(again.client, run.files, { name: "report.pdf" })).toBe(
			"# Report\n\n[Characters 0 to 8 of 8.]",
		);
		expect(again.asked).toEqual([]);
		// another range is parsed
		await parse(again.client, run.files, { name: "report.pdf", pages: "1" });
		expect(again.asked).not.toEqual([]);
	});

	it("refuses a type MinerU cannot read, and a name that is no Attachment", async () => {
		const mineru = parser();
		const run = files({ "notes.txt": pdf });
		await expect(
			parse(mineru.client, run.files, { name: "notes.txt" }),
		).rejects.toThrow(/Parse reads only PDF.*notes.txt is none of them/);
		await expect(
			parse(mineru.client, run.files, { name: "other.pdf" }),
		).rejects.toThrow("There is no attachment named other.pdf.");
		expect(mineru.asked).toEqual([]);
	});

	it("stops parsing when the Run is stopped", async () => {
		// a Document Parser that is never done, until its signal aborts
		const endless: ParserClient = {
			parse: (_, signal) =>
				new Promise((_, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason)),
				),
		};
		const stop = new AbortController();
		const parsing = parse(
			endless,
			files().files,
			{ name: "report.pdf" },
			stop.signal,
		);
		await new Promise((r) => setTimeout(r, 20));
		stop.abort();
		await expect(parsing).rejects.toThrow();
	});

	it("is unavailable without a Document Parser, or without the Run's Attachments", () => {
		const offered = (
			parse: { baseUrl: string; apiKey: string } | undefined,
			parseFiles?: ParseFiles,
		) =>
			builtinTools({ tools: parse ? { parse } : {} }, ["parse"], {
				files: parseFiles,
			}).find((t) => t.name === "parse");
		const mineru = { baseUrl: "https://mineru.net", apiKey: "k" };
		expect(offered(mineru, files().files)).toBeDefined();
		expect(offered(undefined, files().files)).toBeUndefined();
		expect(offered(mineru, undefined)).toBeUndefined();
	});
});
