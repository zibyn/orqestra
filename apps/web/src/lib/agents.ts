import { createServerFn } from "@tanstack/react-start";
import { config } from "#/lib/config";
import { requireAdmin } from "#/lib/instance";

export const listAgents = createServerFn().handler(async () => {
	await requireAdmin();
	const { agents, providers } = await config;
	return {
		// instructions stay server-side; this page only lists Agents
		agents: agents.map((a) => ({
			id: a.id,
			name: a.name,
			description: a.description,
			models: a.models,
			defaultModel: a.defaultModel,
			default: a.default,
		})),
		providers,
	};
});
