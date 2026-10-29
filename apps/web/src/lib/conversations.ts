import {
	modelRef,
	resolveThinking,
	type ThinkingLevel,
} from "@orqestra/config";
import { createConversations } from "@orqestra/conversations";
import { config } from "#/lib/config";

// Conversations of the signed-in user, for the server functions in conversation-fns.ts and the SSE route
export const conversations = createConversations({ config: config.get });

/** The online Agents, with the Models and thinking levels each offers; new Conversations only use `pickable` ones. */
export async function listAgentOptions() {
	const cfg = await config.get();
	// an Agent without Models is offline
	return cfg.agents
		.filter((a) => a.models.length)
		.map((a) => ({
			id: a.id,
			name: a.name,
			description: a.description,
			default: a.default,
			pickable: a.pickable,
			defaultModel: a.defaultModel,
			models: a.models.map((ref) => {
				const model = cfg.models.find((m) => modelRef(m) === ref);
				return {
					ref,
					name: model?.name ?? ref,
					thinking: model
						? resolveThinking(a.thinking, model)
						: { allowed: [], default: "off" as ThinkingLevel },
				};
			}),
		}));
}
