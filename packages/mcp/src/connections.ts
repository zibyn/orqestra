// Users' Connections to per-User OAuth MCP Servers, kept in Postgres with their secrets encrypted: the ConnectionStore the api and
// the worker both use, who is connected, and ending Connections with their tokens revoked.
import { db, type Tx } from "@orqestra/db";
import {
	mcpConnection,
	mcpPendingAuthorization,
	mcpRegisteredClient,
	mcpServer,
	user,
} from "@orqestra/db/schema";
import { decryptSecret, encryptSecret } from "@orqestra/db/secret";
import { and, eq, lt, or, sql } from "drizzle-orm";
import type { McpServer } from "./index.ts";
import {
	type ConnectionStore,
	type ConnectionTokens,
	connectionStatus,
	type OrqestraReach,
	PENDING_TTL_MS,
	type PendingAuthorization,
	revokeConnection,
} from "./oauth.ts";
import { storedClient } from "./servers.ts";

const sealed = (value: unknown) => encryptSecret(JSON.stringify(value));
const opened = <T>(stored: string): T | undefined => {
	const plain = decryptSecret(stored);
	return plain === undefined ? undefined : JSON.parse(plain);
};

const theirs = (userId: string, serverId: string) =>
	and(
		eq(mcpConnection.userId, userId),
		eq(mcpConnection.mcpServerId, serverId),
	);

export const connectionStore: ConnectionStore = {
	async connection(userId, serverId) {
		const row = await db.query.mcpConnection.findFirst({
			where: theirs(userId, serverId),
		});
		return row && { ...row, tokens: opened(row.tokens) };
	},

	lockConnection: (userId, serverId, fn) =>
		db.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${`mcp_connection:${userId}:${serverId}`}))`,
			);
			// read committed: this sees what the lock's last holder wrote
			const row = await tx.query.mcpConnection.findFirst({
				where: theirs(userId, serverId),
			});
			return fn(
				row && { ...row, tokens: opened(row.tokens) },
				async (change) => {
					await tx
						.update(mcpConnection)
						.set(
							"tokens" in change
								? { tokens: sealed(change.tokens), scope: change.scope ?? null }
								: change,
						)
						.where(theirs(userId, serverId));
				},
			);
		}),

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

	async deleteRegisteredClient(serverId) {
		await db
			.delete(mcpRegisteredClient)
			.where(eq(mcpRegisteredClient.mcpServerId, serverId));
	},
};

/** Who is connected to each per-User OAuth MCP Server, for the Admin: the User's name, when, status. Never a token. */
export async function connectedUsers() {
	const rows = await db
		.select({
			serverId: mcpConnection.mcpServerId,
			userId: mcpConnection.userId,
			name: user.name,
			tokens: mcpConnection.tokens,
			status: mcpConnection.status,
			connectedAt: mcpConnection.connectedAt,
		})
		.from(mcpConnection)
		.leftJoin(user, eq(user.id, mcpConnection.userId))
		.orderBy(mcpConnection.connectedAt);
	const byServer: Record<
		string,
		{
			name: string;
			connectedAt: Date;
			status: "connected" | "needs_reconnect";
		}[]
	> = {};
	for (const { serverId, userId, name, tokens, status, connectedAt } of rows) {
		byServer[serverId] ??= [];
		byServer[serverId].push({
			// shortcut: a User with no local record yet shows by their `sub`; every signed-in User gets one (ADR 0008)
			name: name ?? userId,
			connectedAt,
			status: connectionStatus({ status, tokens: decryptSecret(tokens) }),
		});
	}
	return byServer;
}

/** What revoking a deleted Connection needs once its delete is committed. */
export interface DeletedConnection {
	tokens: ConnectionTokens;
	issuer: string;
	oauthClient?: McpServer["oauthClient"];
	registered?: Awaited<ReturnType<ConnectionStore["registeredClient"]>>;
}

const deleted = (
	rows: { tokens: string; issuer: string }[],
	extra: Omit<DeletedConnection, "tokens" | "issuer">,
): DeletedConnection[] =>
	rows.flatMap(({ tokens, issuer }) => {
		const plain = opened<ConnectionTokens>(tokens);
		// tokens that no longer decrypt cannot be revoked
		return plain ? [{ tokens: plain, issuer, ...extra }] : [];
	});

/**
 * Deletes the User's own Connection to the server, then revokes it as far as its authorization server lets it, as the server's
 * pre-registered or registered Client; false when there was none.
 */
export async function deleteConnection(
	userId: string,
	serverId: string,
	reach: Pick<OrqestraReach, "fetch"> = {},
) {
	const [server, registered, rows] = await Promise.all([
		db.query.mcpServer.findFirst({ where: eq(mcpServer.id, serverId) }),
		connectionStore.registeredClient(serverId),
		db.delete(mcpConnection).where(theirs(userId, serverId)).returning(),
	]);
	if (!rows.length) return false;
	const oauthClient = server && storedClient(server);
	await revokeConnections(deleted(rows, { oauthClient, registered }), reach);
	return true;
}

/**
 * In `tx`, deletes every Connection to the server, its pending authorizations and its registered Client, the server's old
 * `oauthClient` being the one they were made as; what revoking them needs, after the commit.
 */
export async function clearConnections(
	tx: Tx,
	serverId: string,
	oauthClient?: McpServer["oauthClient"],
) {
	const rows = await tx
		.delete(mcpConnection)
		.where(eq(mcpConnection.mcpServerId, serverId))
		.returning();
	await tx
		.delete(mcpPendingAuthorization)
		.where(eq(mcpPendingAuthorization.mcpServerId, serverId));
	const [client] = await tx
		.delete(mcpRegisteredClient)
		.where(eq(mcpRegisteredClient.mcpServerId, serverId))
		.returning();
	return deleted(rows, {
		oauthClient,
		registered: client && opened(client.client),
	});
}

/** Revokes deleted Connections as far as their authorization servers let it; failures are only logged. */
export async function revokeConnections(
	connections: DeletedConnection[],
	{ fetch }: Pick<OrqestraReach, "fetch"> = {},
) {
	await Promise.all(
		connections.map(({ tokens, issuer, ...client }) =>
			revokeConnection({ tokens, issuer }, client, fetch).catch((error) =>
				console.error(`Revoking a Connection at ${issuer} failed`, error),
			),
		),
	);
}
