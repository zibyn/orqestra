import { agentId } from "@orqestra/config";
import { agentInput, config } from "@orqestra/config/live";
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "#/lib/session";

// Agent Definitions, edited by Admins in /console/agents.

export const listAgents = createServerFn().handler(async () => {
	await requireAdmin();
	return config.agents.list();
});

/** Field errors by path (`name`, `thinking.default`, …); empty when it was saved. */
export const saveAgent = createServerFn({ method: "POST" })
	.validator(agentInput)
	.handler(async ({ data }) => {
		await requireAdmin();
		return config.agents.save(data);
	});

/** Its Conversations become read-only; Runs already using it finish. */
export const deleteAgent = createServerFn({ method: "POST" })
	.validator(agentId)
	.handler(async ({ data }) => {
		await requireAdmin();
		await config.agents.delete(data);
	});
