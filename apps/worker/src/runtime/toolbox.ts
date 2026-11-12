import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type McpServices, type McpTool, openMcpTools } from "@orqestra/mcp";
import { builtinTools, type ToolServices } from "@orqestra/tools";
import type { ToolRef } from "@orqestra/tools/refs";

/**
 * Opens the Tools of one Run: the built-in ones and those of the MCP Servers among `allowed` that are available (see openMcpTools).
 * Call `close` when the Run ends.
 */
export async function openToolbox(
	services: ToolServices & McpServices,
	allowed: readonly ToolRef[],
	options: Parameters<typeof openMcpTools>[2] &
		Parameters<typeof builtinTools>[2],
): Promise<{
	/** An MCP Server's Tools say which server they are from. */
	tools: (AgentTool | McpTool)[];
	close: () => Promise<unknown>;
}> {
	const { files, pollMs, ...mcp } = options;
	const { tools, close } = await openMcpTools(services, allowed, mcp);
	// MCP Tool names are `<server>__<tool>`, so none is a built-in Tool's
	return {
		tools: [
			...builtinTools(services, allowed, { fetch: mcp.fetch, files, pollMs }),
			...tools,
		],
		close,
	};
}
