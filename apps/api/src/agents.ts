import { agentId } from "@orqestra/config";
import { agentInput, config } from "@orqestra/config/live";
import { Elysia } from "elysia";
import { z } from "zod";
import { saved } from "./saved.ts";

// Agent Definitions, edited by Admins in /console/agents.
export const agents = new Elysia({ prefix: "/agents" })
	.get("/", () => config.agents.list())
	// field errors by path (`name`, `thinking.default`, …)
	.post("/", async ({ body }) => saved(await config.agents.save(body)), {
		body: agentInput,
	})
	// Its Conversations become read-only; Runs already using it finish
	.delete(
		"/:id",
		async ({ params }) => {
			await config.agents.delete(params.id);
		},
		{ params: z.object({ id: agentId }) },
	);
