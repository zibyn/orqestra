import type { AgentsSnapshot } from "@orqestra/agents";
import type { McpSnapshot } from "@orqestra/mcp";
import type { Models } from "@orqestra/models";
import type { SkillInfo } from "@orqestra/skills";
import type { ToolConfig } from "@orqestra/tools/live";
import type { Limits } from "./limits.ts";

/** What a Run reads at its start and a Turn is resolved against: every capability's snapshot, side by side. */
export interface Snapshots
	extends Models,
		ToolConfig,
		McpSnapshot,
		AgentsSnapshot {
	/** Enabled Skills, by name; the others are unavailable. */
	skills: Record<string, SkillInfo>;
	limits: Limits;
}

type Current<T> = { current: () => Promise<T> };

/**
 * Puts the capabilities' current snapshots side by side, again only when one was reloaded: the same object while none is, as a
 * snapshot is. Rejects while any first load fails.
 */
export function snapshots(lives: {
	models: Current<Models>;
	tools: Current<ToolConfig>;
	mcpServers: Current<McpSnapshot>;
	skills: Current<Record<string, SkillInfo>>;
	agents: Current<AgentsSnapshot>;
	limits: Current<Limits>;
}): () => Promise<Snapshots> {
	let last: { from: unknown[]; snapshots: Snapshots } | undefined;
	return async () => {
		const from = await Promise.all([
			lives.models.current(),
			lives.tools.current(),
			lives.mcpServers.current(),
			lives.skills.current(),
			lives.agents.current(),
			lives.limits.current(),
		]);
		if (!last || from.some((f, i) => f !== last?.from[i])) {
			const [m, t, mcp, s, a, l] = from;
			last = {
				from,
				snapshots: { ...m, ...t, ...mcp, skills: s, ...a, limits: l },
			};
		}
		return last.snapshots;
	};
}
