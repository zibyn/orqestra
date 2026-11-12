import { createAgents } from "@orqestra/agents/live";
import { type Db, db as globalDb } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import { limits } from "@orqestra/db/schema";
import { encryptionKey } from "@orqestra/db/secret";
import { loadMcpServers } from "@orqestra/mcp";
import { createModels, type ModelSettings } from "@orqestra/models";
import { createSkills, skillFiles as filesOf } from "@orqestra/skills";
import { createTools } from "@orqestra/tools/live";
import { admin, limitsInput } from "./admin.ts";
import { type OrqestraConfig, resolveConfig, type Settings } from "./index.ts";

/** NOTIFY channel, no payload: the instance config changed, reload it (web -> web and worker). */
const CONFIG_CHANNEL = "config_changed";

// shortcut: re-exported until callers import it from @orqestra/agents/live (#132)
export { agentInput } from "@orqestra/agents/live";
export {
	connectionStore,
	deleteConnection,
	type McpTestResult,
	mcpServerEnabledInput,
	mcpServerInput,
	revokeConnections,
} from "@orqestra/mcp";
// shortcut: re-exported until callers import them from @orqestra/models (#122)
export {
	modelEnabledInput,
	modelPriceInput,
	providerInput,
	providerTestInput,
} from "@orqestra/models";
export {
	SkillNotFound,
	skillCreateInput,
	skillCurrentInput,
	skillEditInput,
	skillEnabledInput,
} from "@orqestra/skills";
export type {
	DocumentParserTestResult,
	SandboxTestResult,
} from "@orqestra/tools";
// shortcut: re-exported until callers import them from @orqestra/tools/live (#122)
export {
	documentParserInput,
	sandboxProviderInput,
	searchProviderInput,
	toolServiceInput,
} from "@orqestra/tools/live";
export { limitsInput } from "./admin.ts";

/** A Skill version's files, read from the global db. */
export const skillFiles = (versionId: number) => filesOf(globalDb, versionId);

/** Everything saved in /console but what the models package loads, with API keys decrypted. */
async function loadSettings(
	db: Db,
): Promise<Omit<Settings, keyof ModelSettings>> {
	const key = encryptionKey();
	const [mcpServers, [saved]] = await Promise.all([
		loadMcpServers(db, key),
		db.select().from(limits),
	]);
	return {
		mcpServers,
		// a stored row, read again by limitsInput so a bad one fails the load like a bad Agent Definition
		limits: saved && limitsInput.parse(saved),
	};
}

/**
 * The instance config: `current()` for Runs and the Agent picker, and per entity what Admins edit in /console.
 * Loaded on the first `current()`, which rejects when that fails (also on a missing ORQESTRA_ENCRYPTION_KEY);
 * every write reloads it here and in every other process once committed. Callers check that the User is an Admin.
 * The api and the worker each create one at startup.
 */
export function createConfig(db: Db) {
	const models = createModels(db);
	const settings = live(db, {
		channel: CONFIG_CHANNEL,
		load: () => loadSettings(db),
	});
	// shortcut: the Skills and Agents keep their own snapshots, put in here until #132 gives Turn resolution them itself
	const skills = createSkills(db);
	const agents = createAgents(db, {
		models,
		skills,
		available: () => current(),
	});
	// shortcut: so do the Tools' services and Sandbox Provider, until #122 deletes @orqestra/config
	const tools = createTools(db);
	// resolved again only when a snapshot was reloaded, the same object while none is, as a snapshot is
	let last: { from: unknown[]; config: Promise<OrqestraConfig> } | undefined;
	const current = async () => {
		const from = await Promise.all([
			settings.current(),
			models.current(),
			skills.current(),
			tools.current(),
			agents.current(),
		]);
		if (!last || from.some((f, i) => f !== last?.from[i])) {
			const [c, m, s, t, a] = from;
			const next = Promise.resolve().then(() => ({
				...resolveConfig(c, m),
				...t,
				skills: s,
				...a,
			}));
			const previous = last?.config;
			// as live does: a failed reload keeps the previous config
			last = {
				from,
				config: previous
					? next.catch((error) => {
							console.error(`${CONFIG_CHANNEL}: reload failed`, error);
							return previous;
						})
					: next,
			};
		}
		return last.config;
	};
	const { write } = settings;
	return {
		current,
		write,
		close: async () => {
			await Promise.all([
				settings.close(),
				models.close(),
				skills.close(),
				tools.close(),
				agents.close(),
			]);
		},
		...admin({ current, write }),
		providers: models.providers,
		searchProviders: tools.searchProviders,
		sandboxProvider: tools.sandboxProvider,
		documentParser: tools.documentParser,
		agents,
		/** Deleting one also removes it from every Agent Definition. */
		skills: { ...skills, delete: agents.deleteSkill },
	};
}

export type Config = ReturnType<typeof createConfig>;
