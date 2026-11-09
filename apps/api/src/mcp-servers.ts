import { mcpServerId } from "@orqestra/config";
import {
	config,
	mcpServerEnabledInput,
	mcpServerInput,
} from "@orqestra/config/live";
import { Elysia } from "elysia";
import { z } from "zod";
import { saved } from "./saved.ts";

// MCP Servers, edited by Admins in /console/mcp. Header values only go in.
export const mcpServers = new Elysia({ prefix: "/mcp-servers" })
	.get("/", () => config.mcpServers.list())
	// once saved, with the connection test's result
	.post("/", async ({ body }) => saved(await config.mcpServers.save(body)), {
		body: mcpServerInput,
	})
	.put(
		"/enabled",
		async ({ body }) => {
			await config.mcpServers.setEnabled(body.id, body.enabled);
		},
		{ body: mcpServerEnabledInput },
	)
	// Also removes it from every Agent Definition
	.delete(
		"/:id",
		async ({ params }) => {
			await config.mcpServers.delete(params.id);
		},
		{ params: z.object({ id: mcpServerId }) },
	);
