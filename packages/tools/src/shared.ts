// No Node imports: browser code can use this module (as @orqestra/tools/shared)
import { searchProviders } from "@orqestra/integrations/shared";
import { z } from "zod";

/** The built-in Tools a Search Provider serves; which one serves each is picked in /console. */
export const searchToolNames = ["search", "scrape"] as const;
export type SearchToolName = (typeof searchToolNames)[number];
/** The built-in Tools, in the order they are offered; Parse is served by the Document Parser. */
export const toolNames = [...searchToolNames, "parse"] as const;
export type ToolName = (typeof toolNames)[number];
/** An Agent's Tool entry: a built-in Tool, or `mcp:<serverId>` for every Tool of that MCP Server. */
export type ToolRef = ToolName | `mcp:${string}`;

/** The Tool entry for every Tool of MCP Server `id`. */
export const mcpToolRef = (id: string) => `mcp:${id}` as const;
/** The MCP Server a Tool entry names, or undefined for a built-in Tool. */
export const mcpServerOf = (tool: string) =>
	tool.startsWith("mcp:") ? tool.slice(4) : undefined;

export const toolName = z.enum(toolNames);
export const searchToolName = z.enum(searchToolNames);
export const searchProviderId = z.enum(searchProviders.map((p) => p.id));
