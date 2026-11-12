import type { AgentsSnapshot } from "@orqestra/agents";
import { createAgents } from "@orqestra/agents/live";
import type { Db } from "@orqestra/db";
import { createMcpServers, type McpSnapshot } from "@orqestra/mcp";
import { createModels, type Models } from "@orqestra/models";
import { createSkills, type SkillInfo, skillFiles } from "@orqestra/skills";
import type { SkillFile } from "@orqestra/skills/shared";
import { createTools, type ToolConfig } from "@orqestra/tools/live";
import { createLimits, type Limits } from "./limits.ts";

/** What a Run reads at its start: every capability's snapshot, side by side. */
export interface OrqestraConfig
	extends Models,
		ToolConfig,
		McpSnapshot,
		AgentsSnapshot {
	/** Enabled Skills, by name; the others are unavailable. */
	skills: Record<string, SkillInfo>;
	limits: Limits;
}

/**
 * Each capability's live configuration, as the api and the worker create them at startup: what Admins edit in /console (callers check
 * that the User is an Admin), and `current()` for Runs and the Agent picker, which rejects while any first load fails (also on a
 * missing ORQESTRA_ENCRYPTION_KEY).
 */
export function createCapabilities(db: Db) {
	const models = createModels(db);
	const tools = createTools(db);
	const mcpServers = createMcpServers(db);
	const skills = createSkills(db);
	const limits = createLimits(db);
	const agents = createAgents(db, {
		models,
		skills,
		// what a Run can use now, for the Agent form
		available: async () => {
			const [t, m, s] = await Promise.all([
				tools.current(),
				mcpServers.current(),
				skills.current(),
			]);
			return { ...t, mcpServers: m.mcpServers, skills: s };
		},
	});
	// put together again only when a snapshot was reloaded, the same object while none is, as a snapshot is
	let last: { from: unknown[]; config: OrqestraConfig } | undefined;
	const current = async () => {
		const from = await Promise.all([
			models.current(),
			tools.current(),
			mcpServers.current(),
			skills.current(),
			agents.current(),
			limits.current(),
		]);
		if (!last || from.some((f, i) => f !== last?.from[i])) {
			const [m, t, mcp, s, a, l] = from;
			last = {
				from,
				config: { ...m, ...t, ...mcp, skills: s, ...a, limits: l },
			};
		}
		return last.config;
	};
	return {
		current,
		close: async () => {
			await Promise.all([
				models.close(),
				tools.close(),
				mcpServers.close(),
				skills.close(),
				agents.close(),
				limits.close(),
			]);
		},
		models,
		tools,
		mcpServers,
		/** A Skill version's files. */
		skillFiles: async (versionId: number): Promise<SkillFile[]> =>
			skillFiles(db, versionId),
		/** Deleting one also removes it from every Agent Definition. */
		skills: { ...skills, delete: agents.deleteSkill },
		agents,
		limits,
	};
}

export type Capabilities = ReturnType<typeof createCapabilities>;
