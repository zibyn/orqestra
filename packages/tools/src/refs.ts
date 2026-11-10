// No imports: browser code can use this module (as @orqestra/tools/refs, through @orqestra/config/shared)

/** The built-in Tools a Search Provider serves; which one serves each is picked in /console. */
export const searchToolNames = ["search", "scrape"] as const;
export type SearchToolName = (typeof searchToolNames)[number];
/** The built-in Tools, in the order they are offered; Parse is served by the Document Parser. */
export const toolNames = [...searchToolNames, "parse"] as const;
export type ToolName = (typeof toolNames)[number];
/** An Agent's Tool entry: a built-in Tool, or `mcp:<serverId>` for every Tool of that MCP Server. */
export type ToolRef = ToolName | `mcp:${string}`;

/** The Search Providers Orqestra supports, with their official baseUrl; each can be configured at most once. */
export const searchProviders = [
	{ id: "tavily", name: "Tavily", baseUrl: "https://api.tavily.com" },
	{ id: "firecrawl", name: "Firecrawl", baseUrl: "https://api.firecrawl.dev" },
	{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
] as const;
export type SearchProviderId = (typeof searchProviders)[number]["id"];

/** The Tool entry for every Tool of MCP Server `id`. */
export const mcpToolRef = (id: string) => `mcp:${id}` as const;
/** The MCP Server a Tool entry names, or undefined for a built-in Tool. */
export const mcpServerOf = (tool: string) =>
	tool.startsWith("mcp:") ? tool.slice(4) : undefined;

/** The Document Parser's address until an Admin types another: mineru.net's online service. */
export const MINERU_URL = "https://mineru.net";
/** mineru.net's online service, whose API (v4) needs a key; any other address is a self-hosted MinerU. */
export const isMineruNet = (url: string) =>
	URL.parse(url)?.hostname === "mineru.net";
