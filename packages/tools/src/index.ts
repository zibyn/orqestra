// The Toolbox: which Tools are available, the Tools of one Run, the MCP connection test, and the orrery client.
// A leaf: knows nothing of how the services are stored or configured.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { cut } from "./cut.ts";
import {
	type McpConnection,
	type McpTool,
	mcpTools,
	type StartBackgroundCall,
} from "./mcp.ts";
import { type DocumentParser, type ParseFiles, parseTool } from "./parse.ts";
import {
	mcpServerOf,
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

/** An MCP Server ready to connect to, with plaintext headers. */
export interface McpServer {
	name: string;
	url: string;
	headers: Record<string, string>;
}

/** The services the Tools need; only usable ones are listed, the other Tools are unavailable. */
export interface ToolServices {
	tools: Partial<Record<SearchToolName, ToolService>> & {
		parse?: DocumentParser;
	};
	mcpServers: Record<string, McpServer>;
}

/** The Tool entries that can be offered in a Run now. */
export const availableTools = (services: ToolServices): ToolRef[] => [
	...toolNames.filter((t) => services.tools[t]),
	...Object.keys(services.mcpServers).map(mcpToolRef),
];

const text = (t: string) => [{ type: "text" as const, text: t }];

// infers `execute`'s params from `parameters`, then fits the Agent's untyped Tool list
const tool = <T extends TSchema>(t: AgentTool<T>) => t as unknown as AgentTool;

/** Search, Scrape and Parse, those of them `offered`; Parse only with the Run's `files`. */
function builtinTools(
	services: ToolServices,
	offered: ToolRef[],
	fetch: Fetch,
	{ files, pollMs }: { files?: ParseFiles; pollMs?: number },
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

/**
 * Opens the Tools of one Run: those of `allowed` that are available. MCP Servers are connected in parallel,
 * for this Run only; one that cannot be connected to or listed is skipped (logged). Call `close` when the Run ends.
 */
export async function openToolbox(
	services: ToolServices,
	allowed: readonly ToolRef[],
	options: {
		signal: AbortSignal;
		fetch?: Fetch;
		/** How long one MCP request (connecting, listing, a Tool call) may take. */
		timeoutMs?: number;
		/** The Run's Attachments, which Parse reads; no Parse without them. */
		files?: ParseFiles;
		/** How often Parse asks the Document Parser whether it is done. */
		pollMs?: number;
		/** Starts a Background Call for an MCP Tool call its server puts in the background; without it, no call declares the Tasks extension. */
		backgroundCall?: StartBackgroundCall;
	},
): Promise<{
	/** An MCP Server's Tools say which server they are from. */
	tools: (AgentTool | McpTool)[];
	close: () => Promise<unknown>;
}> {
	const {
		signal,
		fetch,
		timeoutMs = 60_000,
		backgroundCall,
		...parse
	} = options;
	const available = availableTools(services);
	const offered = allowed.filter((t) => available.includes(t));
	const ids = offered.flatMap((t) => mcpServerOf(t) ?? []);
	const connections: McpConnection[] = [];
	const mcp = await mcpTools(services.mcpServers, ids, connections, {
		signal,
		timeoutMs,
		fetch,
		backgroundCall,
	});
	// a name twice makes the Provider refuse the whole request: keep the first
	const names = new Set<string>();
	const tools = [
		// looked up per call, so a fetch replaced later (tests) is used
		...builtinTools(
			services,
			offered,
			fetch ?? ((i, o) => globalThis.fetch(i, o)),
			parse,
		),
		...mcp,
	].filter((t) => {
		if (!names.has(t.name)) return names.add(t.name);
		console.error(`Tool "${t.name}" is offered twice; only the first is kept`);
		return false;
	});
	return {
		tools,
		close: () => Promise.allSettled(connections.map((c) => c.close())),
	};
}

export {
	type BackgroundCallStart,
	cancelMcpTask,
	failureReason,
	INPUT_REQUIRED,
	type McpTaskState,
	type McpTestResult,
	type McpTool,
	pollMcpTask,
	type StartBackgroundCall,
	testMcpServer,
} from "./mcp.ts";
export * from "./orrery.ts";
export * from "./sandbox.ts";
export type { ObjectStore } from "./store.ts";
export { tar } from "./tar.ts";
