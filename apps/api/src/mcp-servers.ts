import { mcpServerId } from "@orqestra/config";
import {
	type Config,
	mcpServerEnabledInput,
	mcpServerInput,
} from "@orqestra/config/live";
import type { Conversations } from "@orqestra/conversations";
import { callbackUrl, type OrqestraReach } from "@orqestra/tools";
import { Elysia } from "elysia";
import { z } from "zod";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// MCP Servers, edited by Admins in /console/mcp. Header values only go in.
export const mcpServers = (
	signedIn: SignedIn,
	config: Config,
	conversations: Pick<Conversations, "deletingMcpServer">,
	/** Where the callback names Orqestra, and what the test and revocations reach servers with. */
	reach: OrqestraReach & { orqestraUrl: string },
) =>
	new Elysia({ prefix: "/mcp-servers" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", () => config.mcpServers.list())
		// where authorization servers send Users back to, for an Admin registering Orqestra with one
		.get("/callback-url", () => ({ url: callbackUrl(reach.orqestraUrl) }))
		// once saved, with the connection test's result
		.post(
			"/",
			async ({ body }) => saved(await config.mcpServers.save(body, reach)),
			{
				body: mcpServerInput,
			},
		)
		.put(
			"/enabled",
			async ({ body }) => {
				await config.mcpServers.setEnabled(body.id, body.enabled);
			},
			{ body: mcpServerEnabledInput },
		)
		// Also removes it from every Agent Definition and ends its Connections, and cancels its Background Calls first, while it can still be asked
		.delete(
			"/:id",
			async ({ params }) => {
				await conversations.deletingMcpServer(params.id);
				await config.mcpServers.delete(params.id, reach);
			},
			{ params: z.object({ id: mcpServerId }) },
		);
