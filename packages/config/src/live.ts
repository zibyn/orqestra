import { type Db, db as globalDb } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import {
	agent,
	enabledModel,
	limits,
	modelPrice,
	provider,
} from "@orqestra/db/schema";
import { decryptSecret, encryptionKey } from "@orqestra/db/secret";
import { loadMcpServers } from "@orqestra/mcp";
import { createSkills, skillFiles as filesOf } from "@orqestra/skills";
import { createTools, type ToolConfig } from "@orqestra/tools/live";
import { admin, forgetSkill, limitsInput } from "./admin.ts";
import {
	loadConfig,
	modelRef,
	type OrqestraConfig,
	pricesByModel,
	type Settings,
} from "./index.ts";

/** NOTIFY channel, no payload: the instance config changed, reload it (web -> web and worker). */
const CONFIG_CHANNEL = "config_changed";

export {
	connectionStore,
	deleteConnection,
	type McpTestResult,
	mcpServerEnabledInput,
	mcpServerInput,
	revokeConnections,
} from "@orqestra/mcp";
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
export {
	documentParserInput,
	sandboxProviderInput,
	searchProviderInput,
	toolServiceInput,
} from "@orqestra/tools/live";
export {
	agentInput,
	limitsInput,
	modelEnabledInput,
	modelPriceInput,
	providerInput,
	providerTestInput,
} from "./admin.ts";

/** A Skill version's files, read from the global db. */
export const skillFiles = (versionId: number) => filesOf(globalDb, versionId);
export { userConnections } from "./connections.ts";

/** Everything saved in /console, with API keys decrypted. */
async function loadSettings(db: Db): Promise<Settings> {
	const key = encryptionKey();
	const [providers, enabled, prices, mcpServers, agents, [saved]] =
		await Promise.all([
			db.select().from(provider),
			db.select().from(enabledModel),
			db.select().from(modelPrice),
			loadMcpServers(db, key),
			db.select().from(agent).orderBy(agent.createdAt),
			db.select().from(limits),
		]);
	return {
		providers: providers.map((p) => ({
			id: p.id,
			apiKey: decryptSecret(p.apiKey, key),
			baseUrl: p.baseUrl,
		})),
		enabledModels: enabled.map((m) =>
			modelRef({ provider: m.providerId, id: m.modelId }),
		),
		modelPrices: pricesByModel(prices),
		agents,
		mcpServers,
		// a stored row, read again by limitsInput so a bad one fails the load like a bad Agent Definition
		limits: saved && limitsInput.parse(saved),
	};
}

const logWarnings = (
	config: Omit<OrqestraConfig, keyof ToolConfig | "skills">,
) => {
	for (const a of config.agents) {
		for (const ref of a.unavailableModels)
			console.warn(`Agent "${a.id}": Model "${ref}" is not available`);
		if (!a.models.length)
			console.warn(`Agent "${a.id}": no Model is available, so it is offline`);
	}
	return config;
};

/**
 * The instance config: `current()` for Runs and the Agent picker, and per entity what Admins edit in /console.
 * Loaded on the first `current()`, which rejects when that fails (also on a missing ORQESTRA_ENCRYPTION_KEY);
 * every write reloads it here and in every other process once committed. Callers check that the User is an Admin.
 * The api and the worker each create one at startup.
 */
export function createConfig(db: Db) {
	const config = live(db, {
		channel: CONFIG_CHANNEL,
		load: () => loadSettings(db).then(loadConfig).then(logWarnings),
	});
	// shortcut: the Skills keep their own snapshot, put in here until #131 gives Turn resolution the Skills itself
	const skills = createSkills(db);
	// shortcut: so do the Tools' services and Sandbox Provider, until #122 deletes @orqestra/config
	const tools = createTools(db);
	let last:
		| { c: object; s: object; t: object; merged: OrqestraConfig }
		| undefined;
	const current = async () => {
		const [c, s, t] = await Promise.all([
			config.current(),
			skills.current(),
			tools.current(),
		]);
		// the same object while none reloads, as a snapshot is
		if (last?.c !== c || last.s !== s || last.t !== t)
			last = { c, s, t, merged: { ...c, ...t, skills: s } };
		return last.merged;
	};
	return {
		...config,
		current,
		close: async () => {
			await Promise.all([config.close(), skills.close(), tools.close()]);
		},
		...admin({ current, write: config.write }),
		searchProviders: tools.searchProviders,
		sandboxProvider: tools.sandboxProvider,
		documentParser: tools.documentParser,
		skills: {
			...skills,
			/** Also removes it from every Agent Definition. */
			delete: async (name: string) => {
				await skills.delete(name);
				await forgetSkill(config, name);
			},
		},
	};
}

export type Config = ReturnType<typeof createConfig>;
