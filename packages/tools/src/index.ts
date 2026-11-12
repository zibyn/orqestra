// The built-in Tools: which are available, those of one Run, and the orrery client. An MCP Server's Tools are @orqestra/mcp's.
// A leaf: knows nothing of how the services are stored or configured.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { cut } from "./cut.ts";
import { type DocumentParser, type ParseFiles, parseTool } from "./parse.ts";
import {
	mcpToolRef,
	type SearchProviderId,
	type SearchToolName,
	type ToolRef,
	toolNames,
} from "./refs.ts";
import { searchProvider } from "./search.ts";

/** `fetch` as Orqestra calls it, so a test can stand in for it. */
export type Fetch = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export {
	type DocumentParser,
	type DocumentParserTestResult,
	type ParseFiles,
	testDocumentParser,
} from "./parse.ts";
export type {
	SearchProviderId,
	SearchToolName,
	ToolName,
	ToolRef,
} from "./refs.ts";

/** A Tool's Search Provider and its decrypted key. */
export interface ToolService {
	provider: SearchProviderId;
	apiKey: string;
	/** The configured one, else the official one. */
	baseUrl: string;
}

/** The services the Tools need; only usable ones are listed, the other Tools are unavailable. */
export interface ToolServices {
	tools: Partial<Record<SearchToolName, ToolService>> & {
		parse?: DocumentParser;
	};
	/** The MCP Servers whose Tools can be offered, by id. */
	mcpServers: Record<string, unknown>;
}

/** The Tool entries that can be offered in a Run now. */
export const availableTools = (services: ToolServices): ToolRef[] => [
	...toolNames.filter((t) => services.tools[t]),
	...Object.keys(services.mcpServers).map(mcpToolRef),
];

const text = (t: string) => [{ type: "text" as const, text: t }];

// infers `execute`'s params from `parameters`, then fits the Agent's untyped Tool list
const tool = <T extends TSchema>(t: AgentTool<T>) => t as unknown as AgentTool;

/** Search, Scrape and Parse, those of them `offered` that are available; Parse only with the Run's `files`. */
export function builtinTools(
	services: Pick<ToolServices, "tools">,
	offered: readonly ToolRef[],
	{
		// looked up per call, so a fetch replaced later (tests) is used
		fetch = (i, o) => globalThis.fetch(i, o),
		files,
		pollMs,
	}: {
		fetch?: Fetch;
		/** The Run's Attachments, which Parse reads; no Parse without them. */
		files?: ParseFiles;
		/** How often Parse asks the Document Parser whether it is done. */
		pollMs?: number;
	},
): AgentTool[] {
	const tools: AgentTool[] = [];
	const search = offered.includes("search") && services.tools.search;
	if (search) {
		const provider = searchProvider(search, fetch);
		tools.push(
			tool({
				name: "search",
				label: "Search",
				description:
					"Search the web. Returns matching pages with their title, URL and a snippet.",
				parameters: Type.Object({
					query: Type.String({ description: "What to search for" }),
					count: Type.Optional(
						Type.Integer({
							minimum: 1,
							maximum: 20,
							description: "How many results, 5 by default",
						}),
					),
				}),
				execute: async (_id, { query, count }, signal) => {
					const results = await provider.search(query, count ?? 5, signal);
					return {
						content: text(
							results
								.map((r) => `## ${r.title}\n${r.url}\n\n${r.snippet}`)
								.join("\n\n") || "No results.",
						),
						details: undefined,
					};
				},
			}),
		);
	}
	const scrape = offered.includes("scrape") && services.tools.scrape;
	if (scrape) {
		const provider = searchProvider(scrape, fetch);
		tools.push(
			tool({
				name: "scrape",
				label: "Scrape",
				description: "Read one web page and return its content as Markdown.",
				parameters: Type.Object({
					url: Type.String({ description: "The page's http(s) URL" }),
				}),
				execute: async (_id, { url }, signal) => ({
					content: text(cut(await provider.scrape(url, signal))),
					details: undefined,
				}),
			}),
		);
	}
	const parse = offered.includes("parse") && services.tools.parse;
	if (parse && files) tools.push(parseTool(parse, files, fetch, { pollMs }));
	return tools;
}

export * from "./orrery.ts";
export * from "./sandbox.ts";
export type { ObjectStore } from "./store.ts";
export { tar } from "./tar.ts";
