import {
	McpClient,
	type McpFetch,
	McpHttpError,
	McpTimeoutError,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import type { McpServer } from "@orqestra/config";

export type McpTestResult =
	| { ok: true; tools: { name: string; description?: string }[] }
	| {
			ok: false;
			reason: "auth" | "unreachable" | "timeout" | "failed";
			detail: string;
	  };

/** Connects to an MCP Server the way a Run does and lists its Tools; never throws. */
export async function testMcpServer(
	server: Pick<McpServer, "url" | "headers">,
	{ fetch, timeoutMs = 10_000 }: { fetch?: McpFetch; timeoutMs?: number } = {},
): Promise<McpTestResult> {
	const client = new McpClient({
		name: "orqestra",
		version: "1.0.0",
		requestTimeoutMs: timeoutMs,
	});
	const transport = new StreamableHttpTransport({
		url: server.url,
		headers: server.headers,
		fetch,
		openGetStream: false,
	});
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		return {
			ok: true,
			tools: tools.map((t) => ({ name: t.name, description: t.description })),
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const reason =
			error instanceof McpTimeoutError
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
		await client.close().catch(() => {});
	}
}

// fetch hides why it failed (ECONNREFUSED, ENOTFOUND) in its cause
const describe = (error: unknown, detail: string) =>
	error instanceof TypeError && error.cause instanceof Error
		? `${detail}: ${error.cause.message}`
		: detail;
