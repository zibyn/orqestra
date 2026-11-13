import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	getSupportedThinkingLevels,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type ModelThinkingLevel,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export {
	createModels,
	defaultModelInput,
	type ModelsLive,
	modelEnabledInput,
	modelPriceInput,
	providerInput,
	providerTestInput,
} from "./live.ts";

export type ThinkingLevel = ModelThinkingLevel;

/** The Providers, enabled Models and prices an Admin configured in /console, as stored in the database. */
export interface ModelSettings {
	/** `apiKey` is undefined when the stored key cannot be decrypted; `baseUrl` null means the Catalog's. */
	providers: {
		id: string;
		apiKey: string | undefined;
		baseUrl: string | null;
	}[];
	/** As `provider/id`. */
	enabledModels: string[];
	/** The enabled Model an Admin marked as the default, as `provider/id`. */
	defaultModel?: string;
	/** An Admin's prices, by `provider/id`, each replacing the Catalog's `cost` as a whole. */
	modelPrices: Record<string, Model<Api>["cost"]>;
}

export type StreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	// a worker may queue the request before it starts
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** The Models Runs can use, as resolved from `ModelSettings`. */
export interface Models {
	/** pi's Catalog runtime; stream through `streamSimple` so the configured key is used. */
	registry: ModelRegistry;
	/** Enabled Models of configured Providers, with the Provider's baseUrl applied. */
	models: Model<Api>[];
	/** The one of `models` an Admin marked as the default; without one, the first of `models` is (`defaultModelOf`). */
	defaultModel?: Model<Api>;
	/** pi's streamSimple with the Provider's configured API key. */
	streamSimple: StreamSimple;
}

export const modelRef = (m: { provider: string; id: string }) =>
	`${m.provider}/${m.id}`;

/** The default Model: the one an Admin marked, else the first enabled; undefined while none is enabled. */
export const defaultModelOf = (m: Pick<Models, "models" | "defaultModel">) =>
	m.defaultModel ?? m.models[0];

/** An Admin's prices as stored, keyed as `ModelSettings.modelPrices`. */
export const pricesByModel = (
	rows: ({ providerId: string; modelId: string } & Model<Api>["cost"])[],
): ModelSettings["modelPrices"] =>
	Object.fromEntries(
		rows.map(({ providerId, modelId, ...cost }) => [
			modelRef({ provider: providerId, id: modelId }),
			cost,
		]),
	);

/** The price a Model `ref` is costed at: the Admin's, replacing the Catalog's `catalog` as a whole, else that. */
export function priceInForce<C>(
	prices: ModelSettings["modelPrices"],
	ref: string,
	catalog: C,
) {
	const custom = prices[ref];
	return custom
		? { cost: custom, source: "custom" as const }
		: { cost: catalog, source: "catalog" as const };
}

// in-memory stores keep pi from reading or writing ~/.pi; no models.json, so only pi's built-in Catalog.
// Shared by every load, so a Provider registered on it (tests do) survives reloads
let runtime: Promise<ModelRegistry> | undefined;
const catalogRegistry = () =>
	(runtime ??= ModelRuntime.create({
		modelsPath: null,
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	}).then((r) => new ModelRegistry(r)));

// fixed baseUrl and an API key, but pi exchanges the key through OAuth first
const unsupported = ["github-copilot"];

/**
 * The Catalog: pi's built-in Providers that work with one API key and a fixed baseUrl, with their Models.
 * Those needing cloud credentials, URL placeholders or OAuth are left out.
 */
export async function catalogProviders() {
	const registry = await catalogRegistry();
	const providers = [];
	for (const id of new Set(registry.getAll().map((m) => m.provider))) {
		const provider = registry.getProvider(id);
		const models = registry.getAll().filter((m) => m.provider === id);
		const baseUrl = provider?.baseUrl;
		if (
			!provider?.auth?.apiKey ||
			!baseUrl ||
			baseUrl.includes("{") ||
			unsupported.includes(id) ||
			// a custom baseUrl replaces every Model's, so they must share one
			models.some((m) => m.baseUrl !== baseUrl)
		)
			continue;
		providers.push({ id, name: provider.name ?? id, baseUrl, models });
	}
	return providers;
}

/** The enabled Models of configured Providers, and a streamSimple that sends each Provider's key. */
export async function resolveModels(settings: ModelSettings): Promise<Models> {
	const registry = await catalogRegistry();
	const enabled = new Set(settings.enabledModels);
	const models = (await catalogProviders()).flatMap((p) => {
		const configured = settings.providers.find((s) => s.id === p.id);
		if (!configured) return [];
		return p.models
			.filter((m) => enabled.has(modelRef(m)))
			.map((m) => ({
				...m,
				baseUrl: configured.baseUrl || m.baseUrl,
				// pi prices usage.cost with it, so Usage is costed at the price in force
				cost: priceInForce(settings.modelPrices, modelRef(m), m.cost).cost,
			}));
	});
	return {
		registry,
		models,
		defaultModel: models.find((m) => modelRef(m) === settings.defaultModel),
		streamSimple: (model, context, options) => {
			const provider = settings.providers.find((p) => p.id === model.provider);
			if (provider && provider.apiKey === undefined)
				throw new Error(
					`The API key of Provider "${provider.id}" cannot be decrypted (was ORQESTRA_ENCRYPTION_KEY changed?); an Admin must enter it again in /console`,
				);
			return registry.streamSimple(model, context, {
				...options,
				apiKey: provider?.apiKey ?? options?.apiKey,
			});
		},
	};
}

/** Sends a tiny completion to check a Provider's key and baseUrl before they are saved; resolves to an error message, or undefined when it worked. */
export async function testConnection(
	model: Model<Api>,
	apiKey: string,
	baseUrl?: string,
) {
	const registry = await catalogRegistry();
	try {
		const result = await registry
			.streamSimple(
				{ ...model, baseUrl: baseUrl || model.baseUrl },
				{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
				{ apiKey, maxTokens: 16, signal: AbortSignal.timeout(30_000) },
			)
			.result();
		return result.stopReason === "error"
			? (result.errorMessage ?? "Request failed")
			: undefined;
	} catch (error) {
		return (error as Error).message;
	}
}

/** The thinking levels a Model offers, and the one selected by default: `low`, else the lowest supported level above `off`. */
export function resolveThinking(
	model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">,
): { allowed: ThinkingLevel[]; default: ThinkingLevel } {
	const allowed = getSupportedThinkingLevels(model as Model<Api>);
	return {
		allowed,
		default: allowed.includes("low")
			? "low"
			: (allowed.find((l) => l !== "off") ?? allowed[0]),
	};
}
