import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
	type CallToolResult,
	Client,
	isInputRequiredResult,
	type JSONRPCMessage,
	ProtocolError,
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	createTaskSessionFromClient,
	DispatchError,
	type JsonRpcResponse,
	type RawClientDispatch,
	type TaskEnabledSession,
} from "@modelcontextprotocol/ext-tasks/client";
import { cut } from "./cut.ts";
import type { Fetch, McpServer } from "./index.ts";

/** Who Orqestra is to an MCP Server: for now the shared request headers its Admin set. */
export type McpIdentity = { headers: Record<string, string> };

/** A negotiated connection to one MCP Server: the client, and its Tasks extension session. */
export type McpConnection = {
	client: Client;
	session: TaskEnabledSession;
	close: () => Promise<void>;
};

const clientInfo = { name: "orqestra", version: "1.0.0" };

/**
 * The Tools of the MCP Servers `ids`, connected in parallel; a server that cannot be connected to or listed is skipped (logged).
 * Every connection is pushed to `connections`, for the caller to close.
 */
export async function mcpTools(
	servers: Record<string, McpServer>,
	ids: string[],
	connections: McpConnection[],
	{
		signal,
		timeoutMs,
		fetch,
	}: { signal: AbortSignal; timeoutMs: number; fetch?: Fetch },
): Promise<AgentTool[]> {
	const connected = await Promise.all(
		ids.map(async (id) => {
			try {
				const server = servers[id];
				const connection = await connectMcpServer(
					server.url,
					{ headers: server.headers },
					{ signal, timeoutMs, fetch },
				);
				connections.push(connection);
				const { client } = connection;
				const { tools: listed } = await client.listTools(undefined, {
					signal,
					timeout: timeoutMs,
				});
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
								{
									name: t.name,
									arguments: params as Record<string, unknown>,
								},
								{
									signal: callSignal,
									timeout: timeoutMs,
									allowInputRequired: true,
								},
							);
							if (isInputRequiredResult(result))
								throw new Error(
									"This service asked for more input, which Orqestra does not support.",
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
 * Connects to an MCP Server the same way for a Run and for the connection test: on 2026-07-28 when it speaks it,
 * otherwise on the version it does. Declares no elicitation, sampling or roots, and subscribes to nothing.
 * Aborting `signal` closes the connection, which ends a hanging connect and every request; the caller closes it otherwise.
 */
export async function connectMcpServer(
	url: string,
	identity: McpIdentity,
	{
		signal,
		timeoutMs,
		fetch,
	}: {
		signal: AbortSignal;
		/** How long one request may take. */
		timeoutMs: number;
		fetch?: Fetch;
	},
): Promise<McpConnection> {
	signal.throwIfAborted();
	// closing ends every request, the version probe included, which the SDK does not tie to its own close
	const open = new AbortController();
	const send = fetch ?? globalThis.fetch;
	const transport = () =>
		new StreamableHTTPClientTransport(new URL(url), {
			requestInit: { headers: identity.headers },
			fetch: (input, init) =>
				send(input, {
					...init,
					signal: init?.signal
						? AbortSignal.any([init.signal, open.signal])
						: open.signal,
				}),
		});
	const client = new Client(clientInfo, {
		versionNegotiation: { mode: "auto" },
		inputRequired: { autoFulfill: false },
	});
	const raw = rawDispatcher(transport());
	let session: TaskEnabledSession | undefined;
	const close = async () => {
		open.abort(new Error("The MCP connection is closed"));
		await session?.close().catch(() => {});
		await raw.close().catch(() => {});
		await client.close().catch(() => {});
	};
	signal.addEventListener("abort", () => void close(), { once: true });
	try {
		await client.connect(transport(), { signal, timeout: timeoutMs });
		session = createTaskSessionFromClient(client, {
			endpointId: url,
			// ext-tasks then asks for no Tool declarations of its own (one `tools/list` fewer)
			tools: { currentTool: () => undefined },
			rawDispatch: raw.dispatch,
			v2RequestFraming: {
				protocolVersion: client.getNegotiatedProtocolVersion() ?? "",
				clientInfo,
				clientCapabilities: {},
			},
		});
		return { client, session, close };
	} catch (error) {
		await close();
		throw error;
	}
}

/**
 * The raw JSON-RPC path ext-tasks needs for 2026-07-28 task traffic, which the SDK client's codecs refuse:
 * a second transport to the same server, with the same identity.
 */
function rawDispatcher(transport: StreamableHTTPClientTransport) {
	const pending = new Map<string, (response: JsonRpcResponse) => void>();
	let next = 0;
	transport.onmessage = (message: JSONRPCMessage) => {
		if (!("id" in message) || "method" in message) return;
		const settle = pending.get(String(message.id));
		pending.delete(String(message.id));
		settle?.(
			"error" in message
				? { kind: "error", error: message.error as never }
				: { kind: "result", result: message.result as never },
		);
	};
	const started = transport.start();
	const dispatch: RawClientDispatch = async (request, options = {}) => {
		await started;
		const id = `raw-${++next}`;
		const timeoutMs = options.context?.requestTimeoutMs;
		const signal = AbortSignal.any(
			[
				options.signal,
				timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
			].filter((s) => s !== undefined),
		);
		const response = new Promise<JsonRpcResponse>((resolve, reject) => {
			pending.set(id, resolve);
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		});
		try {
			await transport.send(
				{ jsonrpc: "2.0", id, ...(request as object) } as JSONRPCMessage,
				{ requestSignal: signal, headers: options.context?.headers },
			);
			return await response;
		} catch (error) {
			// not retryable: ext-tasks would send it again, and a poll asks once
			throw new DispatchError("MCP request failed", false, { cause: error });
		} finally {
			pending.delete(id);
		}
	};
	return { dispatch, close: () => transport.close() };
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
	{ fetch, timeoutMs = 15_000 }: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<McpTestResult> {
	const signal = AbortSignal.timeout(timeoutMs);
	let connection: McpConnection | undefined;
	try {
		connection = await connectMcpServer(
			server.url,
			{ headers: server.headers },
			{ signal, timeoutMs, fetch },
		);
		const { tools } = await connection.client.listTools(undefined, {
			signal,
			timeout: timeoutMs,
		});
		return {
			ok: true,
			tools: tools.map((t) => ({ name: t.name, description: t.description })),
		};
	} catch (error) {
		return { ok: false, ...explain(error, signal) };
	} finally {
		await connection?.close();
	}
}

function explain(
	error: unknown,
	signal: AbortSignal,
): { reason: "auth" | "unreachable" | "timeout" | "failed"; detail: string } {
	const detail = error instanceof Error ? error.message : String(error);
	const supported = unsupportedVersions(error);
	if (supported)
		return {
			reason: "failed",
			detail: `服务器只支持 MCP ${supported.join(", ")}`,
		};
	if (
		signal.aborted ||
		(error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout)
	)
		return { reason: "timeout", detail };
	const status = httpStatus(error);
	if (status === 401 || status === 403) return { reason: "auth", detail };
	const network = networkFailure(error);
	if (network) return { reason: "unreachable", detail: network };
	return { reason: "failed", detail };
}

/** Follows an error's causes, outermost first. */
function* causes(error: unknown): Generator<unknown> {
	for (let e = error, depth = 0; e !== undefined && depth < 10; depth++) {
		yield e;
		e = e instanceof Error ? e.cause : undefined;
	}
}

function unsupportedVersions(error: unknown): string[] | undefined {
	for (const e of causes(error)) {
		const data = (e as { data?: { supported?: unknown } }).data;
		if (
			((e instanceof ProtocolError && e.code === -32022) ||
				(e instanceof SdkError && Array.isArray(data?.supported))) &&
			Array.isArray(data?.supported)
		)
			return data.supported.map(String);
	}
}

function httpStatus(error: unknown) {
	for (const e of causes(error)) if (e instanceof SdkHttpError) return e.status;
}

// fetch hides why it failed (ECONNREFUSED, ENOTFOUND) in its cause
function networkFailure(error: unknown) {
	for (const e of causes(error))
		if (e instanceof TypeError)
			return e.cause instanceof Error
				? `${e.message}: ${e.cause.message}`
				: e.message;
}

/**
 * A Tool result as text and images for a model. Text and images pass through, embedded text resources become text,
 * embedded image resources become images, and other blocks become a short placeholder. A result without content but
 * with `structuredContent` becomes its JSON, since servers should, but do not always, mirror it as text.
 */
function toLlmContent(
	result: CallToolResult,
): (
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
)[] {
	const content = (result.content ?? []).map((block) => {
		switch (block.type) {
			case "text":
				return { type: "text" as const, text: block.text };
			case "image":
				return {
					type: "image" as const,
					data: block.data,
					mimeType: block.mimeType,
				};
			case "audio":
				return {
					type: "text" as const,
					text: `[audio ${block.mimeType} omitted]`,
				};
			case "resource_link":
				return { type: "text" as const, text: `${block.name}: ${block.uri}` };
			case "resource": {
				const resource = block.resource;
				if ("text" in resource)
					return { type: "text" as const, text: resource.text };
				if (resource.mimeType?.startsWith("image/"))
					return {
						type: "image" as const,
						data: resource.blob,
						mimeType: resource.mimeType,
					};
				return {
					type: "text" as const,
					text: `[binary resource ${resource.uri} (${resource.mimeType ?? "unknown type"}) omitted]`,
				};
			}
			default:
				return {
					type: "text" as const,
					text: `[unsupported MCP content ${(block as { type: string }).type}]`,
				};
		}
	});
	if (content.length === 0 && result.structuredContent !== undefined)
		content.push({
			type: "text",
			text: JSON.stringify(result.structuredContent, null, 2),
		});
	return content;
}
