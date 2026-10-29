import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
	McpClient,
	type McpTransport,
	StreamableHttpTransport,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import type {
	AgentDefinition,
	McpServer,
	OrqestraConfig,
} from "@orqestra/config";
import { MAX_PAGE_CHARS } from "./tools.ts";

/** How long one MCP request (connecting, listing, a Tool call) may take. */
const TIMEOUT_MS = 60_000;

/**
 * The Tools of every MCP Server `allowed` names that is available, connected in parallel.
 * A server that cannot be connected to or listed is skipped (logged); call `close` when the Run ends.
 */
export async function mcpTools(
	config: Pick<OrqestraConfig, "mcpServers">,
	allowed: AgentDefinition["tools"],
	signal: AbortSignal,
	options: {
		transport?: (id: string, server: McpServer) => McpTransport;
		timeoutMs?: number;
	} = {},
) {
	const {
		transport = (_id, { url, headers }) =>
			new StreamableHttpTransport({ url, headers }),
		timeoutMs = TIMEOUT_MS,
	} = options;
	const ids = allowed.flatMap((t) =>
		t.startsWith("mcp:") && config.mcpServers[t.slice(4)] ? [t.slice(4)] : [],
	);
	const clients: McpClient[] = [];
	const connected = await Promise.all(
		ids.map(async (id) => {
			const client = new McpClient({
				name: "orqestra",
				version: "1.0.0",
				requestTimeoutMs: timeoutMs,
			});
			clients.push(client);
			try {
				await client.connect(transport(id, config.mcpServers[id]));
				const listed = await client.listTools({ signal });
				return listed.map(
					(t): AgentTool => ({
						// Providers allow at most 64 characters of [A-Za-z0-9_-]
						name: `${id}__${t.name}`
							.replace(/[^A-Za-z0-9_-]/g, "_")
							.slice(0, 64),
						label: t.title ?? t.name,
						description: t.description ?? t.name,
						// Providers require an object schema, and some reject one without `properties`
						parameters: Type.Unsafe({
							...t.inputSchema,
							type: "object",
							properties: t.inputSchema.properties ?? {},
						}),
						execute: async (_toolCallId, params, callSignal) => {
							const result = await client.callTool(
								t.name,
								params as Record<string, unknown>,
								{ signal: callSignal, timeoutMs },
							);
							return {
								content: toLlmContent(result).map((c) =>
									c.type === "text" && c.text.length > MAX_PAGE_CHARS
										? {
												...c,
												text: `${c.text.slice(0, MAX_PAGE_CHARS)}\n\n[The result was cut off here.]`,
											}
										: c,
								),
								details: undefined,
								// MCP reports a Tool's failure in its result, not as a protocol error
								isError: result.isError === true,
							};
						},
					}),
				);
			} catch (error) {
				console.error(`MCP Server "${id}" is unavailable for this Run`, error);
				return [];
			}
		}),
	);
	return {
		tools: connected.flat(),
		close: () => Promise.allSettled(clients.map((c) => c.close())),
	};
}
