// Users' Connections to per-User OAuth MCP Servers, kept in Postgres with their secrets encrypted: the ConnectionStore the api and
// the worker both use, and what a User's Connections page lists.
import { db } from "@orqestra/db";
import {
	mcpConnection,
	mcpPendingAuthorization,
	mcpRegisteredClient,
	mcpServer,
} from "@orqestra/db/schema";
import {
	type ConnectionStore,
	PENDING_TTL_MS,
	type PendingAuthorization,
} from "@orqestra/tools";
import { and, eq, lt, or } from "drizzle-orm";
import { mcpToolRef, type OrqestraConfig } from "./index.ts";
import { decryptSecret, encryptSecret } from "./secret.ts";

const sealed = (value: unknown) => encryptSecret(JSON.stringify(value));
const opened = <T>(stored: string): T | undefined => {
	const plain = decryptSecret(stored);
	return plain === undefined ? undefined : JSON.parse(plain);
};

export const connectionStore: ConnectionStore = {
	async connection(userId, serverId) {
		const row = await db.query.mcpConnection.findFirst({
			where: and(
				eq(mcpConnection.userId, userId),
				eq(mcpConnection.mcpServerId, serverId),
			),
		});
		return row && { ...row, tokens: opened(row.tokens) };
	},

	async saveConnection(userId, serverId, { tokens, issuer, scope }) {
		const values = {
			tokens: sealed(tokens),
			issuer,
			scope: scope ?? null,
			status: "connected" as const,
			connectedAt: new Date(),
		};
		await db
			.insert(mcpConnection)
			.values({ userId, mcpServerId: serverId, ...values })
			.onConflictDoUpdate({
				target: [mcpConnection.userId, mcpConnection.mcpServerId],
				set: values,
			});
	},

	async addPending({ state, userId, serverId, issuer, createdAt, ...secret }) {
		await db.transaction(async (tx) => {
			// shortcut: expired ones are swept here, by whoever connects next, rather than by a periodic job; enough for their size
			await tx
				.delete(mcpPendingAuthorization)
				.where(
					or(
						and(
							eq(mcpPendingAuthorization.userId, userId),
							eq(mcpPendingAuthorization.mcpServerId, serverId),
						),
						lt(
							mcpPendingAuthorization.createdAt,
							new Date(Date.now() - PENDING_TTL_MS),
						),
					),
				);
			await tx.insert(mcpPendingAuthorization).values({
				state,
				userId,
				mcpServerId: serverId,
				issuer,
				secret: sealed(secret),
				createdAt,
			});
		});
	},

	async takePending(state) {
		const [row] = await db
			.delete(mcpPendingAuthorization)
			.where(eq(mcpPendingAuthorization.state, state))
			.returning();
		const secret =
			row &&
			opened<
				Pick<PendingAuthorization, "codeVerifier" | "client" | "discovery">
			>(row.secret);
		return (
			secret && {
				state: row.state,
				userId: row.userId,
				serverId: row.mcpServerId,
				issuer: row.issuer,
				createdAt: row.createdAt,
				...secret,
			}
		);
	},

	async registeredClient(serverId) {
		const row = await db.query.mcpRegisteredClient.findFirst({
			where: eq(mcpRegisteredClient.mcpServerId, serverId),
		});
		return row && opened(row.client);
	},

	async saveRegisteredClient(serverId, client) {
		const values = { issuer: client.issuer, client: sealed(client) };
		await db
			.insert(mcpRegisteredClient)
			.values({ mcpServerId: serverId, ...values })
			.onConflictDoUpdate({
				target: mcpRegisteredClient.mcpServerId,
				set: values,
			});
	},
};

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
		// tokens that no longer decrypt (another key) cannot be used
		status:
			tokens && decryptSecret(tokens) === undefined
				? ("needs_reconnect" as const)
				: (status ?? ("none" as const)),
		connectedAt,
	}));
}
