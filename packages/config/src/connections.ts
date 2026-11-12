// What a User's Connections page lists: their Connections, with the Agents that use each MCP Server.
import { db } from "@orqestra/db";
import { mcpConnection, mcpServer } from "@orqestra/db/schema";
import { decryptSecret } from "@orqestra/db/secret";
import { connectionStatus } from "@orqestra/mcp";
import { and, eq } from "drizzle-orm";
import { mcpToolRef, type OrqestraConfig } from "./index.ts";

/**
 * Every per-User OAuth MCP Server, disabled ones included, with the User's Connection to it and the Agents the User can pick that use
 * it. Never a token.
 */
export async function userConnections(userId: string, current: OrqestraConfig) {
	const rows = await db
		.select({
			id: mcpServer.id,
			name: mcpServer.name,
			enabled: mcpServer.enabled,
			status: mcpConnection.status,
			tokens: mcpConnection.tokens,
			connectedAt: mcpConnection.connectedAt,
		})
		.from(mcpServer)
		.leftJoin(
			mcpConnection,
			and(
				eq(mcpConnection.mcpServerId, mcpServer.id),
				eq(mcpConnection.userId, userId),
			),
		)
		.where(eq(mcpServer.auth, "oauth"))
		.orderBy(mcpServer.createdAt);
	return rows.map(({ enabled, status, tokens, connectedAt, ...server }) => ({
		...server,
		disabled: !enabled,
		agents: current.agents
			.filter((a) => a.pickable && a.tools.includes(mcpToolRef(server.id)))
			.map((a) => a.name),
		status:
			tokens && status
				? connectionStatus({ status, tokens: decryptSecret(tokens) })
				: ("none" as const),
		connectedAt,
	}));
}
