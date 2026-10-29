import { CONFIG_CHANNEL, db } from "@orqestra/db";
import {
	agent,
	enabledModel,
	mcpServer,
	provider,
	searchProvider,
	toolService,
} from "@orqestra/db/schema";
import { sql } from "drizzle-orm";
import { admin } from "./admin.ts";
import {
	loadConfig,
	modelRef,
	type OrqestraConfig,
	type SearchProviderId,
	type Settings,
	toolName,
} from "./index.ts";
import { decryptSecret, encryptionKey } from "./secret.ts";

export {
	agentInput,
	mcpServerEnabledInput,
	mcpServerInput,
	modelEnabledInput,
	providerInput,
	providerTestInput,
	searchProviderInput,
	toolServiceInput,
} from "./admin.ts";
export type { McpTestResult } from "./mcp.ts";

/** Everything saved in /console, with API keys decrypted. */
async function loadSettings(): Promise<Settings> {
	const key = encryptionKey();
	const [providers, enabled, searchProviders, served, mcpServers, agents] =
		await Promise.all([
			db.select().from(provider),
			db.select().from(enabledModel),
			db.select().from(searchProvider),
			db.select().from(toolService),
			db.select().from(mcpServer).orderBy(mcpServer.createdAt),
			db.select().from(agent).orderBy(agent.createdAt),
		]);
	const servedBy = (tool: string) =>
		(served.find((s) => s.tool === tool)?.searchProviderId ??
			null) as SearchProviderId | null;
	return {
		providers: providers.map((p) => ({
			id: p.id,
			apiKey: decryptSecret(p.apiKey, key),
			baseUrl: p.baseUrl,
		})),
		enabledModels: enabled.map((m) =>
			modelRef({ provider: m.providerId, id: m.modelId }),
		),
		agents,
		searchProviders: searchProviders.map((p) => ({
			id: p.id as SearchProviderId,
			apiKey: decryptSecret(p.apiKey, key),
			baseUrl: p.baseUrl,
		})),
		servedBy: { search: servedBy("search"), scrape: servedBy("scrape") },
		mcpServers: mcpServers.map((s) => ({
			id: s.id,
			name: s.name,
			url: s.url,
			enabled: s.enabled,
			headers: s.headers.map((h) => ({
				name: h.name,
				value: decryptSecret(h.value, key),
			})),
		})),
	};
}

const logWarnings = (config: OrqestraConfig) => {
	for (const a of config.agents) {
		for (const ref of a.unavailableModels)
			console.warn(`Agent "${a.id}": Model "${ref}" is not available`);
		if (!a.models.length)
			console.warn(`Agent "${a.id}": no Model is available, so it is offline`);
	}
	for (const tool of toolName.options)
		if (!config.tools[tool])
			console.warn(
				`Tool "${tool}" has no usable Search Provider, so Agents run without it`,
			);
	return config;
};

/**
 * Loads the config on the first `get()`, then reloads it on every CONFIG_CHANNEL notification.
 * `get()` rejects when the first load fails (also on a missing ORQESTRA_ENCRYPTION_KEY); a failed reload keeps the previous config.
 * A Run holds the config it started with, so a reload never changes a Run in progress.
 */
export function liveConfig() {
	let current: Promise<OrqestraConfig> | undefined;
	let listener: Promise<{ release(destroy: boolean): void }> | undefined;
	let latest = 0;
	let newest: Promise<void> = Promise.resolve();
	const load = () => loadSettings().then(loadConfig).then(logWarnings);
	/** Resolves once the config is at least as fresh as this reload. */
	const refresh = () => {
		const next = load();
		const seq = ++latest;
		newest = next.then(
			() => {
				// an older reload finishing late must not replace a newer one
				if (seq === latest) current = next;
				else return newest;
			},
			(error) => console.error("config reload failed", error),
		);
		return newest;
	};
	const start = () => {
		encryptionKey();
		// LISTEN before the first load so no change slips in between
		// shortcut: a dropped connection silently stops reloads; reconnect if that shows up in practice
		const connected = db.$client.connect().then(async (client) => {
			await client.query(`LISTEN ${CONFIG_CHANNEL}`);
			client.on("notification", () => void refresh());
			return client;
		});
		listener = connected;
		return connected.then(load);
	};
	return {
		get: () => (current ??= start()),
		/** Tells every process to reload, and reloads this one before resolving. */
		reload: async () => {
			await db.execute(sql`select pg_notify(${CONFIG_CHANNEL}, '')`);
			if (current) await refresh();
		},
		close: async () => (await listener)?.release(true),
	};
}

/**
 * The instance config: `current()` for Runs and the Agent picker, and per entity what Admins edit in /console.
 * Every write reloads it here and in every other process once committed. Callers check that the User is an Admin.
 */
function createConfig() {
	const live = liveConfig();
	return {
		current: live.get,
		close: live.close,
		...admin({
			current: live.get,
			write: async (fn) => {
				const result = await db.transaction(fn);
				await live.reload();
				return result;
			},
		}),
	};
}

export const config = createConfig();
