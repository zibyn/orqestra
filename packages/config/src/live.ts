import type { Db } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import {
	agent,
	documentParser,
	enabledModel,
	limits,
	modelPrice,
	provider,
	sandboxProvider,
	searchProvider,
	skill,
	skillVersion,
} from "@orqestra/db/schema";
import { decryptSecret, encryptionKey } from "@orqestra/db/secret";
import { loadMcpServers } from "@orqestra/mcp";
import { availableTools } from "@orqestra/tools";
import { eq } from "drizzle-orm";
import { admin, limitsInput, servedBy } from "./admin.ts";
import {
	loadConfig,
	modelRef,
	type OrqestraConfig,
	pricesByModel,
	type SearchProviderId,
	type Settings,
	toolName,
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
export type {
	DocumentParserTestResult,
	SandboxTestResult,
} from "@orqestra/tools";
export {
	agentInput,
	documentParserInput,
	limitsInput,
	modelEnabledInput,
	modelPriceInput,
	providerInput,
	providerTestInput,
	SkillNotFound,
	sandboxProviderInput,
	searchProviderInput,
	skillCreateInput,
	skillCurrentInput,
	skillEditInput,
	skillEnabledInput,
	skillFiles,
	toolServiceInput,
} from "./admin.ts";
export { userConnections } from "./connections.ts";

/** Everything saved in /console, with API keys decrypted. */
async function loadSettings(db: Db): Promise<Settings> {
	const key = encryptionKey();
	const [
		providers,
		enabled,
		prices,
		searchProviders,
		served,
		mcpServers,
		agents,
		skills,
		[sandbox],
		[saved],
		[parser],
	] = await Promise.all([
		db.select().from(provider),
		db.select().from(enabledModel),
		db.select().from(modelPrice),
		db.select().from(searchProvider),
		servedBy(db),
		loadMcpServers(db, key),
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
		db.select().from(sandboxProvider),
		db.select().from(limits),
		db.select().from(documentParser),
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
		searchProviders: searchProviders.map((p) => ({
			id: p.id as SearchProviderId,
			apiKey: decryptSecret(p.apiKey, key),
			baseUrl: p.baseUrl,
		})),
		servedBy: served,
		mcpServers,
		skills,
		// a stored row, read again by limitsInput so a bad one fails the load like a bad Agent Definition
		limits: saved && limitsInput.parse(saved),
		sandboxProvider: sandbox && {
			url: sandbox.url,
			token: decryptSecret(sandbox.token, key),
			snapshot: sandbox.snapshot,
			cpu: sandbox.cpu,
			memory: sandbox.memory,
		},
		documentParser: parser && {
			enabled: parser.enabled,
			url: parser.url,
			apiKey: parser.apiKey === null ? null : decryptSecret(parser.apiKey, key),
		},
	};
}

const logWarnings = (config: OrqestraConfig) => {
	for (const a of config.agents) {
		for (const ref of a.unavailableModels)
			console.warn(`Agent "${a.id}": Model "${ref}" is not available`);
		if (!a.models.length)
			console.warn(`Agent "${a.id}": no Model is available, so it is offline`);
	}
	const available = availableTools(config);
	for (const tool of toolName.options)
		if (!available.includes(tool))
			console.warn(
				`Tool "${tool}" has no usable ${tool === "parse" ? "Document Parser" : "Search Provider"}, so Agents run without it`,
			);
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
	return { ...config, ...admin(config) };
}

export type Config = ReturnType<typeof createConfig>;
