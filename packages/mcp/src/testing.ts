// A scripted MCP Server and authorization server, and Connections kept in memory, for testing what talks MCP without real ones.
import type {
	ConnectionStore,
	PendingAuthorization,
	StoredConnection,
} from "./oauth.ts";

export * from "./fake-mcp.ts";
export * from "./fake-oauth.ts";

/** Connections, pending authorizations and registered Clients kept in memory; `connections` holds them by `${userId} ${serverId}`. */
export function memoryConnections() {
	const connections = new Map<string, StoredConnection>();
	const pending = new Map<string, PendingAuthorization>();
	const clients = new Map<
		string,
		Awaited<ReturnType<ConnectionStore["registeredClient"]>>
	>();
	const locks = new Map<string, Promise<unknown>>();
	const store: ConnectionStore = {
		connection: async (userId, serverId) =>
			connections.get(`${userId} ${serverId}`),
		saveConnection: async (userId, serverId, c) => {
			connections.set(`${userId} ${serverId}`, {
				...c,
				scope: c.scope ?? null,
				status: "connected",
				connectedAt: new Date(),
			});
		},
		lockConnection: (userId, serverId, fn) => {
			const key = `${userId} ${serverId}`;
			const held = (locks.get(key) ?? Promise.resolve())
				.catch(() => {})
				.then(() =>
					fn(connections.get(key), async (change) => {
						const c = connections.get(key);
						if (!c) return;
						connections.set(
							key,
							"tokens" in change
								? { ...c, tokens: change.tokens, scope: change.scope ?? null }
								: { ...c, ...change },
						);
					}),
				);
			locks.set(key, held);
			return held;
		},
		addPending: async (p) => {
			for (const [state, q] of pending)
				if (q.userId === p.userId && q.serverId === p.serverId)
					pending.delete(state);
			pending.set(p.state, p);
		},
		takePending: async (state) => {
			const p = pending.get(state);
			pending.delete(state);
			return p;
		},
		registeredClient: async (serverId) => clients.get(serverId),
		saveRegisteredClient: async (serverId, client) => {
			clients.set(serverId, client);
		},
		deleteRegisteredClient: async (serverId) => {
			clients.delete(serverId);
		},
	};
	return Object.assign(store, { connections });
}
