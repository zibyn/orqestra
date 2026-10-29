import {
	McpClient,
	type McpFetch,
	type McpTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import type { McpServer } from "./index.ts";

/**
 * Connects to an MCP Server the same way for a Run and for the connection test.
 * Aborting `signal` closes the client, which ends a hanging connect and every request; the caller closes it otherwise.
 */
export async function connectMcpServer(
	server: Pick<McpServer, "url" | "headers">,
	{
		signal,
		timeoutMs,
		fetch,
		transport = new StreamableHttpTransport({
			url: server.url,
			headers: server.headers,
			fetch,
		}),
	}: {
		signal: AbortSignal;
		/** How long one request may take. */
		timeoutMs: number;
		fetch?: McpFetch;
		transport?: McpTransport;
	},
) {
	signal.throwIfAborted();
	const client = new McpClient({
		name: "orqestra",
		version: "1.0.0",
		requestTimeoutMs: timeoutMs,
	});
	signal.addEventListener("abort", () => void client.close().catch(() => {}), {
		once: true,
	});
	await client.connect(transport); // closes the client itself when it fails
	return client;
}
