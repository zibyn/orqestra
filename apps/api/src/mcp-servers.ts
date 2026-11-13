import type { Conversations } from "@orqestra/conversations";
import {
	callbackUrl,
	type McpServersLive,
	mcpServerEnabledInput,
	mcpServerId,
	mcpServerInput,
	type OrqestraReach,
} from "@orqestra/mcp";
import { Elysia } from "elysia";
import { z } from "zod";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// MCP Servers, edited by Admins in /console/mcp. Header values only go in.
export const mcpServers = (
	signedIn: SignedIn,
	mcpServers: McpServersLive,
	conversations: Pick<Conversations, "deleteMcpServer">,
	/** Where the callback names Orqestra, and what the test and revocations reach servers with. */
	reach: OrqestraReach & { orqestraUrl: string },
) =>
	new Elysia({ prefix: "/mcp-servers" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", () => mcpServers.list())
		// where authorization servers send Users back to, for an Admin registering Orqestra with one
		.get("/callback-url", () => ({ url: callbackUrl(reach.orqestraUrl) }))
		// once saved, with the connection test's result
		.post("/", async ({ body }) => saved(await mcpServers.save(body, reach)), {
			body: mcpServerInput,
		})
		.put(
			"/enabled",
			async ({ body }) => {
				await mcpServers.setEnabled(body.id, body.enabled);
			},
			{ body: mcpServerEnabledInput },
		)
		// Also cancels its Background Calls, ends its Connections and removes it from every Agent Definition
		.delete(
			"/:id",
			async ({ params }) => {
				await conversations.deleteMcpServer(params.id);
			},
			{ params: z.object({ id: mcpServerId }) },
		);
