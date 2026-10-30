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
import type { McpServer, ToolService } from "@orqestra/tools";
import type { z } from "zod";
import {
	agentDefinition,
	definitionIssues,
	type SearchProviderId,
	searchProviders,
	type ToolName,
	type ToolRef,
	toolName,
} from "./shared.ts";

export * from "./shared.ts";

export type ThinkingLevel = ModelThinkingLevel;

export interface AgentDefinition {
	id: string;
	name: string;
	description: string;
	/** System prompt: the Markdown body. */
	instructions: string;
	/** Allowed Models as `provider/id`, only those available; every enabled Model when the definition has no `models`. Empty: the Agent is offline. */
	models: string[];
	/** The definition names no Models; a Subagent from it then runs on the Model of the Agent that started it. */
	allModels: boolean;
	/** One of `models`, or "" when the Agent is offline. */
	defaultModel: string;
	/** As written; resolve per Model with `resolveThinking`. */
	thinking: { default?: ThinkingLevel; allowed?: ThinkingLevel[] };
	compaction?: { reserveTokens?: number; keepRecentTokens?: number };
	/** As written; only built-in Tools with a Search Provider and available MCP Servers are offered in a Run. */
	tools: ToolRef[];
	/** Users can start Conversations with it; any Agent can be a Subagent template. */
	pickable: boolean;
	default: boolean;
	/** Models the definition names that are not available (disabled, deleted, or gone from the Catalog), as `provider/id`. */
	unavailableModels: string[];
}

/** What an Admin configured in /console, as stored in the database. */
export interface Settings {
	/** `apiKey` is undefined when the stored key cannot be decrypted; `baseUrl` null means the Catalog's. */
	providers: {
		id: string;
		apiKey: string | undefined;
		baseUrl: string | null;
	}[];
	/** As `provider/id`. */
	enabledModels: string[];
	/** Agent Definitions as stored, validated by `loadConfig`. */
	agents: { id: string; definition: unknown }[];
	/** `apiKey` is undefined when the stored key cannot be decrypted; `baseUrl` null means the official one. */
	searchProviders: {
		id: SearchProviderId;
		apiKey: string | undefined;
		baseUrl: string | null;
	}[];
	/** The Search Provider picked for each Tool. */
	servedBy: Record<ToolName, SearchProviderId | null>;
	/** A header `value` is undefined when it cannot be decrypted. */
	mcpServers: {
		id: string;
		name: string;
		url: string;
		enabled: boolean;
		headers: { name: string; value: string | undefined }[];
	}[];
}

export interface OrqestraConfig {
	/** pi's Catalog runtime; stream through `streamSimple` so the configured key is used. */
	registry: ModelRegistry;
	/** Enabled Models of configured Providers, with the Provider's baseUrl applied. */
	models: Model<Api>[];
	agents: AgentDefinition[];
	defaultAgent: AgentDefinition;
	/** Tools with a usable Search Provider; the others are unavailable. */
	tools: Partial<Record<ToolName, ToolService>>;
	/** Enabled MCP Servers whose headers decrypt, by id; the others are unavailable. */
	mcpServers: Record<string, McpServer>;
	/** pi's streamSimple with the Provider's configured API key. */
	streamSimple: StreamSimple;
}

type StreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	// a worker may queue the request before it starts
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export class ConfigError extends Error {
	override name = "ConfigError";
}

export const modelRef = (m: { provider: string; id: string }) =>
	`${m.provider}/${m.id}`;

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

/**
 * Resolves the stored Agent Definitions against the configured Providers, Models and Search Providers.
 * Throws a ConfigError naming each bad Agent and field; a Model that is not available only warns.
 */
export async function loadConfig(settings: Settings): Promise<OrqestraConfig> {
	const registry = await catalogRegistry();
	const enabled = new Set(settings.enabledModels);
	const models = (await catalogProviders()).flatMap((p) => {
		const configured = settings.providers.find((s) => s.id === p.id);
		if (!configured) return [];
		return p.models
			.filter((m) => enabled.has(modelRef(m)))
			.map((m) => ({ ...m, baseUrl: configured.baseUrl || m.baseUrl }));
	});
	const known = models.map(modelRef);

	const errors: string[] = [];
	const agents: AgentDefinition[] = [];
	for (const row of settings.agents) {
		const fail = (field: string, message: string) =>
			errors.push(`Agent "${row.id}": ${field ? `${field}: ` : ""}${message}`);
		const parsed = agentDefinition.safeParse(row.definition);
		if (!parsed.success) {
			for (const issue of parsed.error.issues)
				fail(issueField(issue), issue.message);
			continue;
		}
		const def = parsed.data;
		for (const issue of definitionIssues(def)) fail(issue.field, issue.message);
		const { models: named, defaultModel, thinking, tools, ...rest } = def;
		const available = named
			? named.filter((ref) => known.includes(ref))
			: [...known];
		let fallback = defaultModel ?? named?.[0] ?? "";
		fallback ||= process.env.ORQESTRA_DEFAULT_MODEL ?? "";
		agents.push({
			...rest,
			id: row.id,
			models: available,
			allModels: !named,
			defaultModel: available.includes(fallback)
				? fallback
				: (available[0] ?? ""),
			thinking: thinking ?? {},
			tools: tools ?? [...toolName.options],
			unavailableModels: (named ?? []).filter((ref) => !known.includes(ref)),
		});
	}

	const defaults = agents.filter((a) => a.default);
	if (defaults.length !== 1)
		errors.push(
			`exactly one Agent must be the default (found ${
				defaults.map((a) => a.id).join(", ") || "none"
			})`,
		);
	if (errors.length)
		throw new ConfigError(`Invalid configuration:\n  ${errors.join("\n  ")}`);

	const tools: OrqestraConfig["tools"] = {};
	for (const tool of toolName.options) {
		const picked = settings.servedBy[tool];
		const stored = settings.searchProviders.find((p) => p.id === picked);
		if (picked && stored?.apiKey)
			tools[tool] = {
				provider: picked,
				apiKey: stored.apiKey,
				baseUrl:
					stored.baseUrl ||
					searchProviders.find((p) => p.id === picked)?.baseUrl ||
					"",
			};
	}

	const mcpServers: OrqestraConfig["mcpServers"] = {};
	for (const { id, name, url, enabled, headers } of settings.mcpServers) {
		const plain = headers.flatMap((h) =>
			h.value === undefined ? [] : [[h.name, h.value]],
		);
		// one unreadable header: the server would reject us, so it is unavailable
		if (enabled && plain.length === headers.length)
			mcpServers[id] = { name, url, headers: Object.fromEntries(plain) };
	}

	return {
		registry,
		models,
		agents,
		defaultAgent: defaults[0],
		tools,
		mcpServers,
		streamSimple: (model, context, options) => {
			const provider = settings.providers.find((p) => p.id === model.provider);
			if (provider && provider.apiKey === undefined)
				throw new ConfigError(
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

const issueField = (issue: z.core.$ZodIssue) =>
	[
		...issue.path,
		...(issue.code === "unrecognized_keys" ? [issue.keys.join(", ")] : []),
	].join(".");

/**
 * The thinking levels an Agent offers on a Model, and the one selected by default:
 * the Agent's `thinking.default`, else `low`, else the lowest supported level above `off`.
 */
export function resolveThinking(
	thinking: AgentDefinition["thinking"],
	model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">,
): { allowed: ThinkingLevel[]; default: ThinkingLevel } {
	const supported = getSupportedThinkingLevels(model as Model<Api>);
	const allowed = thinking.allowed
		? supported.filter((l) => thinking.allowed?.includes(l))
		: supported;
	// the Agent's levels may not overlap this Model's; fall back to what the Model can do
	const offered = allowed.length ? allowed : supported;
	const preferred = [thinking.default, "low"].find(
		(l): l is ThinkingLevel => !!l && offered.includes(l as ThinkingLevel),
	);
	return {
		allowed: offered,
		default: preferred ?? offered.find((l) => l !== "off") ?? offered[0],
	};
}

/** System prompt of the general worker. */
export const GENERAL_WORKER =
	"You carry out one task for another agent, starting without any prior context. Work through it with the tools you have, then reply with a complete, self-contained answer: it is all the other agent will see.";

/** The built-in Agent a Subagent without a template runs as: any enabled Model, Search and Scrape, no MCP Server. */
const generalWorker = (models: Model<Api>[]): AgentDefinition => ({
	id: "",
	name: "General worker",
	description: "",
	instructions: GENERAL_WORKER,
	models: models.map(modelRef),
	allModels: true,
	defaultModel: models[0] ? modelRef(models[0]) : "",
	thinking: {},
	tools: [...toolName.options],
	pickable: false,
	default: false,
	unavailableModels: [],
});

/**
 * The Agent, Model and thinking level for the next message of a Conversation.
 * A pick the Agent no longer allows falls back to its default.
 * Returns undefined when the Agent was removed from config or has no Model left: the Conversation is then read-only.
 */
export function resolveTurn(
	config: Pick<OrqestraConfig, "agents" | "models">,
	/** null: the general worker, a Subagent started without a template. */
	agentId: string | null,
	picked: { model?: string; thinking?: ThinkingLevel } = {},
) {
	const agent =
		agentId === null
			? generalWorker(config.models)
			: config.agents.find((a) => a.id === agentId);
	if (!agent?.models.length) return undefined;
	const ref =
		picked.model && agent.models.includes(picked.model)
			? picked.model
			: agent.defaultModel;
	// loadConfig keeps only available Models in agent.models
	const find = (ref: string) =>
		config.models.find((m) => modelRef(m) === ref) as Model<Api>;
	const model = find(ref);
	/** The Agent's default Model, whatever was picked: it titles the Conversation. */
	const defaultModel = find(agent.defaultModel);
	const levels = resolveThinking(agent.thinking, model);
	const thinking =
		picked.thinking && levels.allowed.includes(picked.thinking)
			? picked.thinking
			: levels.default;
	return { agent, model, defaultModel, thinking };
}
