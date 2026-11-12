// MCP Servers: the protocol client, a Run's MCP Tools, the connection test and probe, the Background Call poll and cancel, Users'
// Connections with OAuth, and what Admins edit in /console/mcp.
import type { AuthProvider } from "@modelcontextprotocol/client";
import {
	type McpConnection,
	type McpTool,
	mcpTools,
	type StartBackgroundCall,
} from "./mcp.ts";
import { type ConnectionStore, connectionAuth } from "./oauth.ts";

/** `fetch` as Orqestra calls it, so a test can stand in for it. */
export type Fetch = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

/** An MCP Server ready to connect to, with plaintext headers. */
export interface McpServer {
	name: string;
	url: string;
	/** Omitted: shared, every User sends `headers`; oauth: each User connects with their own account. */
	auth?: "shared" | "oauth";
	/** A Client pre-registered with its authorization server, for oauth; omitted: Orqestra uses its own or registers. */
	oauthClient?: { client_id: string; client_secret?: string };
	headers: Record<string, string>;
}

/** The MCP Servers a Run can use, by id. */
export type McpServices = { mcpServers: Record<string, McpServer> };

/** What MCP Servers and their authorization servers are reached with, and where the Users' Connections are kept. */
export type McpAccess = { fetch?: Fetch; connections?: ConnectionStore };

/**
 * How a request to a per-User OAuth MCP Server signs in as `userId`: with their Connection's token, refreshed on a 401; undefined
 * when they have none usable, or no Connections are kept.
 */
export const signIn = (
	server: McpServer,
	serverId: string,
	userId: string,
	{ fetch, connections }: McpAccess,
): Promise<AuthProvider | undefined> | undefined =>
	connections
		? connectionAuth(connections, userId, serverId, { server, fetch })
		: undefined;

/**
 * Opens the MCP Tools of one Run: those of the `mcp:<id>` entries of `allowed` whose servers are available, connected in parallel,
 * for this Run only; one that cannot be connected to or listed is skipped (logged). A per-User OAuth one only when `userId` has
 * a usable Connection to it in `connections`, else left out without a word. Call `close` when the Run ends.
 */
export async function openMcpTools(
	services: McpServices,
	allowed: readonly string[],
	options: McpAccess & {
		signal: AbortSignal;
		/** How long one MCP request (connecting, listing, a Tool call) may take. */
		timeoutMs?: number;
		/** Starts a Background Call for an MCP Tool call its server puts in the background; without it, no call declares the Tasks extension. */
		backgroundCall?: StartBackgroundCall;
		/** The Run's User: its top-level Conversation's, also for Subagents and Firings. */
		userId?: string;
	},
): Promise<{
	/** Each says which server it is from. */
	tools: McpTool[];
	close: () => Promise<unknown>;
}> {
	const { signal, fetch, timeoutMs = 60_000, backgroundCall, userId } = options;
	const { mcpServers } = services;
	const allowedIds = allowed.flatMap((t) =>
		t.startsWith("mcp:") && mcpServers[t.slice(4)] ? [t.slice(4)] : [],
	);
	const auth: Record<string, AuthProvider> = {};
	await Promise.all(
		allowedIds
			.filter((id) => mcpServers[id].auth === "oauth")
			.map(async (id) => {
				if (!userId) return;
				const provider = await Promise.resolve(
					signIn(mcpServers[id], id, userId, options),
				).catch(
					(error) =>
						void console.error(
							`Reading the Connection of ${userId} to MCP Server "${id}" failed`,
							error,
						),
				);
				if (provider) auth[id] = provider;
			}),
	);
	// decided as the Run starts: a Connection made during it counts from the next Run
	const ids = allowedIds.filter(
		(id) => mcpServers[id].auth !== "oauth" || auth[id],
	);
	const connections: McpConnection[] = [];
	const listed = await mcpTools(mcpServers, ids, connections, {
		signal,
		timeoutMs,
		fetch,
		backgroundCall,
		auth,
	});
	// a name twice makes the Provider refuse the whole request: keep the first
	const names = new Set<string>();
	const tools = listed.filter((t) => {
		if (!names.has(t.name)) return names.add(t.name);
		console.error(`Tool "${t.name}" is offered twice; only the first is kept`);
		return false;
	});
	return {
		tools,
		close: () => Promise.allSettled(connections.map((c) => c.close())),
	};
}

export {
	clearConnections,
	connectedUsers,
	connectionStore,
	type DeletedConnection,
	deleteConnection,
	revokeConnections,
} from "./connections.ts";
export {
	type BackgroundCallStart,
	cancelMcpTask,
	failureReason,
	INPUT_REQUIRED,
	type McpProbe,
	type McpTaskState,
	type McpTestResult,
	type McpTool,
	pollMcpTask,
	probeMcpServer,
	type StartBackgroundCall,
	type TaskRequestOptions,
	testMcpServer,
} from "./mcp.ts";
export {
	type ConnectionStore,
	type ConnectionTokens,
	callbackUrl,
	clientMetadataDocument,
	connectionAuth,
	connectionStatus,
	type FinishConnectionError,
	finishConnection,
	type OAuthDiscoveryStep,
	type OrqestraReach,
	PENDING_TTL_MS,
	type PendingAuthorization,
	REVOKE_TIMEOUT_MS,
	revokeConnection,
	type StartConnectionError,
	type StoredConnection,
	startConnection,
} from "./oauth.ts";
export {
	createMcpServers,
	deleteMcpServer,
	loadMcpServers,
	type McpServerSettings,
	type McpServersLive,
	type McpSnapshot,
	mcpServerAdmin,
	mcpServerEnabledInput,
	mcpServerId,
	mcpServerInput,
	resolveMcpServers,
	storedClient,
} from "./servers.ts";
