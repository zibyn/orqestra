import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
	McpClient,
	type McpFetch,
	McpHttpError,
	McpTimeoutError,
	type McpTransport,
	StreamableHttpTransport,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import { cut } from "./cut.ts";
import type { McpServer } from "./index.ts";

/**
 * The Tools of the MCP Servers `ids`, connected in parallel; a server that cannot be connected to or listed is skipped (logged).
 * Every client is pushed to `clients`, for the caller to close.
 */
export async function mcpTools(
	servers: Record<string, McpServer>,
	ids: string[],
	clients: McpClient[],
	{
		signal,
		timeoutMs,
		fetch,
		transport,
	}: {
		signal: AbortSignal;
		timeoutMs: number;
		fetch?: McpFetch;
		transport?: (id: string, server: McpServer) => McpTransport;
	},
): Promise<AgentTool[]> {
	const connected = await Promise.all(
		ids.map(async (id) => {
			try {
				const server = servers[id];
				const client = await connectMcpServer(server, {
					signal,
					timeoutMs,
					fetch,
					transport: transport?.(id, server),
				});
				clients.push(client);
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
									c.type === "text" ? { ...c, text: cut(c.text) } : c,
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
	return connected.flat();
}

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

export type McpTestResult =
	| { ok: true; tools: { name: string; description?: string }[] }
	| {
			ok: false;
			reason: "auth" | "unreachable" | "timeout" | "failed";
			detail: string;
	  };

/** Connects to an MCP Server the way a Run does and lists its Tools within `timeoutMs` in all; never throws. */
export async function testMcpServer(
	server: Pick<McpServer, "url" | "headers">,
	{ fetch, timeoutMs = 15_000 }: { fetch?: McpFetch; timeoutMs?: number } = {},
): Promise<McpTestResult> {
	const signal = AbortSignal.timeout(timeoutMs);
	let client: McpClient | undefined;
	try {
		client = await connectMcpServer(server, { signal, timeoutMs, fetch });
		const tools = await client.listTools({ signal });
		return {
			ok: true,
			tools: tools.map((t) => ({ name: t.name, description: t.description })),
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const reason =
			error instanceof McpTimeoutError || signal.aborted
				? "timeout"
				: error instanceof McpHttpError
					? [401, 403].includes(error.status)
						? "auth"
						: "failed"
					: error instanceof TypeError // fetch's network failure
						? "unreachable"
						: "failed";
		return { ok: false, reason, detail: describe(error, detail) };
	} finally {
		await client?.close().catch(() => {});
	}
}

// fetch hides why it failed (ECONNREFUSED, ENOTFOUND) in its cause
const describe = (error: unknown, detail: string) =>
	error instanceof TypeError && error.cause instanceof Error
		? `${detail}: ${error.cause.message}`
		: detail;
