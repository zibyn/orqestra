import type { Agents } from "@orqestra/agents/live";
import {
	clientMetadataDocument,
	connectionStatus,
	connectionStore,
	deleteConnection,
	finishConnection,
	type McpServersLive,
	mcpServerId,
	type OrqestraReach,
	startConnection,
} from "@orqestra/mcp";
import { Elysia } from "elysia";
import { z } from "zod";
import { signedInOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";

const refused = (code: string) => ({ errors: { serverId: { code } } });

/**
 * /api/connections: the signed-in User's own Connections to per-User OAuth MCP Servers, and the two addresses authorization servers
 * know Orqestra by, under `orqestraUrl`: the callback, and the Client ID Metadata Document (served signed out).
 */
export const connectionRoutes = (
	signedIn: SignedIn,
	mcpServers: Pick<McpServersLive, "current">,
	agents: Pick<Agents, "userConnections">,
	{ orqestraUrl, fetch }: OrqestraReach & { orqestraUrl: string },
) =>
	new Elysia({ prefix: "/connections" })
		.get("/client-metadata.json", () => clientMetadataDocument(orqestraUrl))
		.use(signedIn)
		// the popup lands here from the authorization server, then on the Connections page, which tells its opener
		.get("/callback", async ({ user, request, redirect }) => {
			const { serverId, error } = user
				? await finishConnection(
						{
							userId: user.id,
							store: connectionStore,
							orqestraUrl,
							fetch,
							server: (id) =>
								mcpServers.current().then((c) => c.allMcpServers[id]),
						},
						new URL(request.url).searchParams,
					)
				: { error: "state_invalid" as const };
			const to = new URLSearchParams(
				error ? { error } : { connected: serverId ?? "" },
			);
			return redirect(`/connections?${to}`, 302);
		})
		.derive(signedInOnly)
		.get("/", ({ user }) => agents.userConnections(user.id))
		// the authorization URL, for the User to open in a popup
		.post(
			"/:serverId",
			async ({ user, params: { serverId }, status }) => {
				const current = await mcpServers.current();
				const server = current.allMcpServers[serverId];
				if (server?.auth !== "oauth") return status(404, refused("not_found"));
				if (!current.mcpServers[serverId])
					return status(409, refused("server_disabled"));
				// one per User and server: switching accounts is disconnecting first
				const connection = await connectionStore.connection(user.id, serverId);
				if (connection && connectionStatus(connection) === "connected")
					return status(409, refused("connection_exists"));
				const started = await startConnection({
					userId: user.id,
					serverId,
					server,
					store: connectionStore,
					orqestraUrl,
					fetch,
				});
				if ("url" in started) return started;
				return status(started.error === "oauth_client_required" ? 422 : 502, {
					errors: {
						serverId: { code: started.error, detail: started.detail },
					},
				});
			},
			{ params: z.object({ serverId: mcpServerId }) },
		)
		// only the User's own, revoked as far as the authorization server lets it
		.delete(
			"/:serverId",
			async ({ user, params: { serverId }, status }) => {
				if (!(await deleteConnection(user.id, serverId, { fetch })))
					return status(404, refused("not_found"));
			},
			{ params: z.object({ serverId: mcpServerId }) },
		);
