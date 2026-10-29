import { CONFIG_CHANNEL, db } from "@orqestra/db";
import {
	agent,
	enabledModel,
	instanceSettings,
	provider,
	searchProvider,
} from "@orqestra/db/schema";
import {
	generalAgent,
	loadConfig,
	modelRef,
	type OrqestraConfig,
	type SearchProviderId,
	type Settings,
	toolName,
} from "./index.ts";
import { decryptSecret, encryptionKey } from "./secret.ts";

/** Everything saved in /console, with API keys decrypted; writes the General Agent into a database without Agents. */
export async function loadSettings(): Promise<Settings> {
	const key = encryptionKey();
	const [providers, enabled, searchProviders, [instance]] = await Promise.all([
		db.select().from(provider),
		db.select().from(enabledModel),
		db.select().from(searchProvider),
		db.select().from(instanceSettings),
	]);
	let agents = await db.select().from(agent).orderBy(agent.createdAt);
	if (!agents.length) {
		// web and worker may both get here first
		await db
			.insert(agent)
			.values({ id: "general", definition: generalAgent })
			.onConflictDoNothing();
		agents = await db.select().from(agent).orderBy(agent.createdAt);
	}
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
		servedBy: {
			search: (instance?.searchServedBy ?? null) as SearchProviderId | null,
			scrape: (instance?.scrapeServedBy ?? null) as SearchProviderId | null,
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
	for (const tool of toolName.options)
		if (!config.tools[tool])
			console.warn(
				`Tool "${tool}" has no usable Search Provider, so Agents run without it`,
			);
	return config;
};

/**
 * Loads the config on the first `get()`, then reloads it on every CONFIG_CHANNEL notification.
 * `get()` rejects when the first load fails; a failed reload keeps the previous config.
 * A Run holds the config it started with, so a reload never changes a Run in progress.
 */
export function liveConfig() {
	encryptionKey(); // fail at startup, not on first use
	let current: Promise<OrqestraConfig> | undefined;
	let listener: Promise<{ release(destroy: boolean): void }> | undefined;
	const load = () => loadSettings().then(loadConfig).then(logWarnings);
	const start = () => {
		// LISTEN before the first load so no change slips in between
		// shortcut: a dropped connection silently stops reloads; reconnect if that shows up in practice
		const connected = db.$client.connect().then(async (client) => {
			await client.query(`LISTEN ${CONFIG_CHANNEL}`);
			let latest = 0;
			client.on("notification", () => {
				const next = load();
				const seq = ++latest;
				next.then(
					() => {
						// an older reload finishing late must not replace a newer one
						if (seq === latest) current = next;
					},
					(error) => console.error("config reload failed", error),
				);
			});
			return client;
		});
		listener = connected;
		return connected.then(load);
	};
	return {
		get: () => (current ??= start()),
		close: async () => (await listener)?.release(true),
	};
}
