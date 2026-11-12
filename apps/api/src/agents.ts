import { agentInput } from "@orqestra/agents/live";
import { agentId } from "@orqestra/agents/shared";
import type { Capabilities } from "@orqestra/conversations";
import { Elysia } from "elysia";
import { z } from "zod";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// Agent Definitions, edited by Admins in /console/agents.
export const agents = (signedIn: SignedIn, config: Capabilities) =>
	new Elysia({ prefix: "/agents" })
		.use(signedIn)
		.derive(adminOnly)
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
