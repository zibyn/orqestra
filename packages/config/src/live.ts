import { type Db, db as globalDb } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import {
	agent,
	documentParser,
	enabledModel,
	limits,
	mcpServer,
	modelPrice,
	provider,
	sandboxProvider,
	searchProvider,
} from "@orqestra/db/schema";
import { decryptSecret, encryptionKey } from "@orqestra/db/secret";
import { createSkills, skillFiles as filesOf } from "@orqestra/skills";
import { availableTools } from "@orqestra/tools";
import {
	admin,
	forgetSkill,
	limitsInput,
	servedBy,
	storedClient,
} from "./admin.ts";
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
	SkillNotFound,
	skillCreateInput,
	skillCurrentInput,
	skillEditInput,
	skillEnabledInput,
} from "@orqestra/skills";
export type {
	DocumentParserTestResult,
	McpTestResult,
	SandboxTestResult,
} from "@orqestra/tools";
export {
	agentInput,
	documentParserInput,
	limitsInput,
	mcpServerEnabledInput,
	mcpServerInput,
	modelEnabledInput,
	modelPriceInput,
	providerInput,
	providerTestInput,
	sandboxProviderInput,
	searchProviderInput,
	toolServiceInput,
} from "./admin.ts";

/** A Skill version's files, read from the global db. */
export const skillFiles = (versionId: number) => filesOf(globalDb, versionId);
export {
	connectionStore,
	deleteConnection,
	revokeConnections,
	userConnections,
} from "./connections.ts";

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
		[sandbox],
		[saved],
		[parser],
	] = await Promise.all([
		db.select().from(provider),
		db.select().from(enabledModel),
		db.select().from(modelPrice),
		db.select().from(searchProvider),
		servedBy(db),
		db.select().from(mcpServer).orderBy(mcpServer.createdAt),
		db.select().from(agent).orderBy(agent.createdAt),
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

const logWarnings = (config: Omit<OrqestraConfig, "skills">) => {
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
	// shortcut: the Skills keep their own snapshot, put in here until #131 gives Turn resolution the Skills itself
	const skills = createSkills(db);
	let last: { c: object; s: object; merged: OrqestraConfig } | undefined;
	const current = async () => {
		const [c, s] = await Promise.all([config.current(), skills.current()]);
		// the same object while neither reloads, as a snapshot is
		if (last?.c !== c || last.s !== s)
			last = { c, s, merged: { ...c, skills: s } };
		return last.merged;
	};
	return {
		...config,
		current,
		close: async () => {
			await Promise.all([config.close(), skills.close()]);
		},
		...admin({ current, write: config.write }),
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
