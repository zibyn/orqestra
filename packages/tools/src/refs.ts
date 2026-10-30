// No imports: browser code can use this module (as @orqestra/tools/refs, through @orqestra/config/shared)

/** The built-in Tools, in the order they are offered; which Search Provider serves each is picked in /console. */
export const toolNames = ["search", "scrape"] as const;
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
