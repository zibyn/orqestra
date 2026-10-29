import {
	type McpClient,
	type McpFetch,
	McpHttpError,
	McpTimeoutError,
} from "@earendil-works/pi-mcp";
import type { McpServer } from "@orqestra/config";
import { connectMcpServer } from "@orqestra/config/mcp";

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
