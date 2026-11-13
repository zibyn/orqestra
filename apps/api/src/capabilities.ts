import { createAgents } from "@orqestra/agents/live";
import { createLimits, snapshots } from "@orqestra/conversations";
import type { Db } from "@orqestra/db";
import { createMcpServers } from "@orqestra/mcp";
import { createModels } from "@orqestra/models";
import { createSkills, skillFiles } from "@orqestra/skills";
import { createTools } from "@orqestra/tools/live";

/**
 * Each capability's live configuration, created once at startup: what Admins edit in /console (routes check that the User is an
 * Admin), and `current()`, every snapshot side by side for Conversations, which rejects while any first load fails (also on a
 * missing ORQESTRA_ENCRYPTION_KEY).
 */
export function createCapabilities(db: Db) {
	const models = createModels(db);
	const tools = createTools(db);
	const mcpServers = createMcpServers(db);
	const skills = createSkills(db);
	const limits = createLimits(db);
	const agents = createAgents(db, {
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
	const lives = { models, tools, mcpServers, skills, agents, limits };
	return {
		...lives,
		current: snapshots(lives),
		skillFiles: (versionId: number) => skillFiles(db, versionId),
		close: async () => {
			await Promise.all(Object.values(lives).map((l) => l.close()));
		},
	};
}

export type Capabilities = ReturnType<typeof createCapabilities>;
