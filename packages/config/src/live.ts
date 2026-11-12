import type { Db } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import {
	agent,
	documentParser,
	limits,
	mcpServer,
	sandboxProvider,
	searchProvider,
	skill,
	skillVersion,
} from "@orqestra/db/schema";
import { decryptSecret, encryptionKey } from "@orqestra/db/secret";
import { createModels, type ModelSettings } from "@orqestra/models";
import { availableTools } from "@orqestra/tools";
import { eq } from "drizzle-orm";
import { admin, limitsInput, servedBy, storedClient } from "./admin.ts";
import {
	type OrqestraConfig,
	resolveConfig,
	type SearchProviderId,
	type Settings,
	toolName,
} from "./index.ts";

/** NOTIFY channel, no payload: the instance config changed, reload it (web -> web and worker). */
const CONFIG_CHANNEL = "config_changed";

// shortcut: re-exported until callers import them from @orqestra/models (#122)
export {
	modelEnabledInput,
	modelPriceInput,
	providerInput,
	providerTestInput,
} from "@orqestra/models";
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
export {
	connectionStore,
	deleteConnection,
	revokeConnections,
	userConnections,
} from "./connections.ts";

/** Everything saved in /console but what the models package loads, with API keys decrypted. */
async function loadSettings(
	db: Db,
): Promise<Omit<Settings, keyof ModelSettings>> {
	const key = encryptionKey();
	const [
		searchProviders,
		served,
		mcpServers,
		agents,
		skills,
		[sandbox],
		[saved],
		[parser],
	] = await Promise.all([
		db.select().from(searchProvider),
		servedBy(db),
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
		db.select().from(sandboxProvider),
		db.select().from(limits),
		db.select().from(documentParser),
	]);
	return {
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
	const models = createModels(db);
	const settings = live(db, {
		channel: CONFIG_CHANNEL,
		load: () => loadSettings(db),
	});
	// resolved again only when either snapshot was reloaded
	let last:
		| { from: [unknown, unknown]; config: Promise<OrqestraConfig> }
		| undefined;
	const current = async () => {
		const [s, m] = await Promise.all([settings.current(), models.current()]);
		if (last?.from[0] !== s || last.from[1] !== m) {
			const next = Promise.resolve().then(() =>
				logWarnings(resolveConfig(s, m)),
			);
			const previous = last?.config;
			// as live does: a failed reload keeps the previous config
			last = {
				from: [s, m],
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
		close: () => Promise.all([settings.close(), models.close()]),
		...admin({ current, write }),
		providers: models.providers,
	};
}

export type Config = ReturnType<typeof createConfig>;
