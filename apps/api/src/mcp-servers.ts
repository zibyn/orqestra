import { mcpServerId } from "@orqestra/config";
import {
	config,
	mcpServerEnabledInput,
	mcpServerInput,
} from "@orqestra/config/live";
import type { Conversations } from "@orqestra/conversations";
import type { Fetch } from "@orqestra/tools";
import { Elysia } from "elysia";
import { z } from "zod";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// MCP Servers, edited by Admins in /console/mcp. Header values only go in.
export const mcpServers = (
	signedIn: SignedIn,
	conversations: Pick<Conversations, "deletingMcpServer">,
	fetch?: Fetch,
) =>
	new Elysia({ prefix: "/mcp-servers" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", () => config.mcpServers.list())
		// once saved, with the connection test's result
		.post(
			"/",
			async ({ body }) => saved(await config.mcpServers.save(body, { fetch })),
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
		// Also removes it from every Agent Definition, and cancels its Background Calls first, while it can still be asked
		.delete(
			"/:id",
			async ({ params }) => {
				await conversations.deletingMcpServer(params.id);
				await config.mcpServers.delete(params.id);
			},
			{ params: z.object({ id: mcpServerId }) },
		);
