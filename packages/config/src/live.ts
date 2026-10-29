import { CONFIG_CHANNEL, db } from "@orqestra/db";
import { enabledModel, provider } from "@orqestra/db/schema";
import {
	loadConfig,
	type ModelSettings,
	modelRef,
	type OrqestraConfig,
} from "./index.ts";
import { decryptSecret, encryptionKey } from "./secret.ts";

/** The Providers and enabled Models saved in /console, with API keys decrypted. */
export async function loadModelSettings(): Promise<ModelSettings> {
	const key = encryptionKey();
	const [providers, enabled] = await Promise.all([
		db.select().from(provider),
		db.select().from(enabledModel),
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
	};
}

const logWarnings = (config: OrqestraConfig) => {
	for (const agent of config.agents) {
		for (const ref of agent.unavailableModels)
			console.warn(`Agent "${agent.id}": Model "${ref}" is not available`);
		if (!agent.models.length)
			console.warn(
				`Agent "${agent.id}": no Model is available, so it is offline`,
			);
	}
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
	const load = () => loadModelSettings().then(loadConfig).then(logWarnings);
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
