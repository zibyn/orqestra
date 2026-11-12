import type { Db } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import {
	agent,
	enabledModel,
	limits,
	mcpServer,
	modelPrice,
	provider,
	skill,
	skillVersion,
} from "@orqestra/db/schema";
import { decryptSecret, encryptionKey } from "@orqestra/db/secret";
import { createTools, type ToolConfig } from "@orqestra/tools/live";
import { eq } from "drizzle-orm";
import { admin, limitsInput, storedClient } from "./admin.ts";
import {
	loadConfig,
	modelRef,
	type OrqestraConfig,
	pricesByModel,
	type Settings,
} from "./index.ts";

/** NOTIFY channel, no payload: the instance config changed, reload it (web -> web and worker). */
const CONFIG_CHANNEL = "config_changed";

export type {
	DocumentParserTestResult,
	McpTestResult,
	SandboxTestResult,
} from "@orqestra/tools";
// shortcut: re-exported until #122 deletes @orqestra/config; import them from @orqestra/tools/live
export {
	documentParserInput,
	sandboxProviderInput,
	searchProviderInput,
	toolServiceInput,
} from "@orqestra/tools/live";
export {
	agentInput,
	limitsInput,
	mcpServerEnabledInput,
	mcpServerInput,
	modelEnabledInput,
	modelPriceInput,
	providerInput,
	providerTestInput,
	SkillNotFound,
	skillCreateInput,
	skillCurrentInput,
	skillEditInput,
	skillEnabledInput,
	skillFiles,
} from "./admin.ts";
export {
	connectionStore,
	deleteConnection,
	revokeConnections,
	userConnections,
} from "./connections.ts";

/** Everything saved in /console, with API keys decrypted. */
async function loadSettings(db: Db): Promise<Settings> {
	const key = encryptionKey();
	const [providers, enabled, prices, mcpServers, agents, skills, [saved]] =
		await Promise.all([
			db.select().from(provider),
			db.select().from(enabledModel),
			db.select().from(modelPrice),
			db.select().from(mcpServer).orderBy(mcpServer.createdAt),
			db.select().from(agent).orderBy(agent.createdAt),
			db
				.select({
					name: skill.name,
					enabled: skill.enabled,
					versionId: skillVersion.id,
					description: skillVersion.description,
					disableModelInvocation: skillVersion.disableModelInvocation,
				})
				.from(skill)
				.innerJoin(skillVersion, eq(skill.currentVersionId, skillVersion.id))
				.orderBy(skill.name),
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
		mcpServers: mcpServers.map((s) => ({
			id: s.id,
			name: s.name,
			url: s.url,
			enabled: s.enabled,
			auth: s.auth,
			oauthClient: storedClient(s, key) ?? null,
			headers: s.headers.map((h) => ({
				name: h.name,
				value: decryptSecret(h.value, key),
			})),
		})),
		skills,
		// a stored row, read again by limitsInput so a bad one fails the load like a bad Agent Definition
		limits: saved && limitsInput.parse(saved),
	};
}

const logWarnings = (config: Omit<OrqestraConfig, keyof ToolConfig>) => {
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
	// shortcut: the Tools' config is loaded by @orqestra/tools and merged in until #122 deletes @orqestra/config
	const tools = createTools(db);
	let merged: { c: object; t: object; config: OrqestraConfig } | undefined;
	/** The same object while neither snapshot changes, as a single snapshot was. */
	const current = async (): Promise<OrqestraConfig> => {
		const [c, t] = await Promise.all([config.current(), tools.current()]);
		if (merged?.c !== c || merged.t !== t)
			merged = { c, t, config: { ...c, ...t } };
		return merged.config;
	};
	return {
		...config,
		current,
		close: () => Promise.all([config.close(), tools.close()]).then(() => {}),
		...admin({ current, write: config.write }),
		searchProviders: tools.searchProviders,
		sandboxProvider: tools.sandboxProvider,
		documentParser: tools.documentParser,
	};
}

export type Config = ReturnType<typeof createConfig>;
