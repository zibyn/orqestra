import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { thinkingLevel } from "./shared.ts";

export { messageText, thinkingLevel } from "./shared.ts";

export type ThinkingLevel = ModelThinkingLevel;

// strict: an Agent Definition must not carry Conversation- or User-specific fields, so it can back a subagent later
const frontmatterSchema = z.strictObject({
	name: z.string().min(1),
	description: z.string().min(1),
	models: z.array(z.string()).min(1).optional(),
	defaultModel: z.string().optional(),
	thinking: z
		.strictObject({
			default: thinkingLevel.optional(),
			allowed: z.array(thinkingLevel).min(1).optional(),
		})
		.optional(),
	compaction: z
		.strictObject({
			reserveTokens: z.number().int().positive().optional(),
			keepRecentTokens: z.number().int().positive().optional(),
		})
		.optional(),
	default: z.boolean().optional(),
});

export interface AgentDefinition {
	/** File name without `.md`. */
	id: string;
	name: string;
	description: string;
	/** System prompt: the Markdown body. */
	instructions: string;
	/** Allowed Models as `provider/id`, only those available; every enabled Model when the file has no `models`. Empty: the Agent is offline. */
	models: string[];
	/** One of `models`, or "" when the Agent is offline. */
	defaultModel: string;
	/** As written; resolve per Model with `resolveThinking`. */
	thinking: { default?: ThinkingLevel; allowed?: ThinkingLevel[] };
	compaction?: { reserveTokens?: number; keepRecentTokens?: number };
	default: boolean;
	/** Models the file names that are not available (disabled, deleted, or gone from the Catalog), as `provider/id`. */
	unavailableModels: string[];
}

/** The Providers and enabled Models an Admin configured in /console, as stored in the database. */
export interface ModelSettings {
	/** `apiKey` is undefined when the stored key cannot be decrypted; `baseUrl` null means the Catalog's. */
	providers: {
		id: string;
		apiKey: string | undefined;
		baseUrl: string | null;
	}[];
	/** As `provider/id`. */
	enabledModels: string[];
}

export interface OrqestraConfig {
	/** pi's Catalog runtime; stream through `streamSimple` so the configured key is used. */
	registry: ModelRegistry;
	/** Enabled Models of configured Providers, with the Provider's baseUrl applied. */
	models: Model<Api>[];
	agents: AgentDefinition[];
	defaultAgent: AgentDefinition;
	/** pi's streamSimple with the Provider's configured API key. */
	streamSimple: StreamSimple;
}

type StreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export class ConfigError extends Error {
	override name = "ConfigError";
}

export const modelRef = (m: { provider: string; id: string }) =>
	`${m.provider}/${m.id}`;

// shortcut: resolves to the repo's config/ from the source tree; a bundled build must set ORQESTRA_CONFIG_DIR
const defaultConfigDir = () =>
	process.env.ORQESTRA_CONFIG_DIR ||
	fileURLToPath(new URL("../../../config", import.meta.url));

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
 * Loads Agent Definitions from the config directory (`ORQESTRA_CONFIG_DIR`, default `config/` at the repo root)
 * against the Providers and Models configured in the database.
 * Throws a ConfigError naming each bad file and field; a Model that is not available only warns.
 */
export async function loadConfig(
	settings: ModelSettings,
	dir = defaultConfigDir(),
): Promise<OrqestraConfig> {
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
	const agentsDir = join(dir, "agents");
	const files = existsSync(agentsDir)
		? readdirSync(agentsDir)
				.filter((f) => f.endsWith(".md"))
				.sort()
		: [];
	const agents: AgentDefinition[] = [];
	for (const file of files) {
		const path = join(agentsDir, file);
		const fail = (field: string, message: string) =>
			errors.push(`${path}: ${field ? `${field}: ` : ""}${message}`);
		const agent = parseAgent(path, readFileSync(path, "utf8"), fail);
		if (!agent) continue;

		if (
			agent.models.length &&
			agent.defaultModel &&
			!agent.models.includes(agent.defaultModel)
		)
			fail(
				"defaultModel",
				`"${agent.defaultModel}" is not one of the Agent's allowed Models`,
			);
		agent.unavailableModels = agent.models.filter(
			(ref) => !known.includes(ref),
		);
		agent.models = agent.models.length
			? agent.models.filter((ref) => known.includes(ref))
			: [...known];
		agent.defaultModel ||= process.env.ORQESTRA_DEFAULT_MODEL ?? "";
		if (!agent.models.includes(agent.defaultModel))
			agent.defaultModel = agent.models[0] ?? "";
		const { default: level, allowed } = agent.thinking;
		if (level && allowed && !allowed.includes(level))
			fail("thinking.default", `"${level}" is not in thinking.allowed`);
		agents.push(agent);
	}

	const defaults = agents.filter((a) => a.default);
	if (defaults.length !== 1)
		errors.push(
			`${agentsDir}: exactly one Agent must have \`default: true\` (found ${
				defaults.map((a) => a.id).join(", ") || "none"
			})`,
		);
	if (errors.length)
		throw new ConfigError(`Invalid configuration:\n  ${errors.join("\n  ")}`);

	return {
		registry,
		models,
		agents,
		defaultAgent: defaults[0],
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

function parseAgent(
	path: string,
	text: string,
	fail: (field: string, message: string) => void,
): AgentDefinition | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
	if (!match) return void fail("", "missing YAML frontmatter");
	let data: unknown;
	try {
		data = parseYaml(match[1]);
	} catch (e) {
		return void fail("", `invalid YAML: ${(e as Error).message}`);
	}
	const parsed = frontmatterSchema.safeParse(data ?? {});
	if (!parsed.success) {
		for (const issue of parsed.error.issues)
			fail(issueField(issue), issue.message);
		return;
	}
	const { models, defaultModel, thinking, ...rest } = parsed.data;
	return {
		...rest,
		id: basename(path, ".md"),
		instructions: match[2].trim(),
		models: models ?? [],
		defaultModel: defaultModel ?? models?.[0] ?? "",
		thinking: thinking ?? {},
		default: rest.default ?? false,
		unavailableModels: [],
	};
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

/**
 * The Agent, Model and thinking level for the next message of a Conversation.
 * A pick the Agent no longer allows falls back to its default.
 * Returns undefined when the Agent was removed from config or has no Model left: the Conversation is then read-only.
 */
export function resolveTurn(
	config: Pick<OrqestraConfig, "agents" | "models">,
	agentId: string,
	picked: { model?: string; thinking?: ThinkingLevel } = {},
) {
	const agent = config.agents.find((a) => a.id === agentId);
	if (!agent?.models.length) return undefined;
	const ref =
		picked.model && agent.models.includes(picked.model)
			? picked.model
			: agent.defaultModel;
	// loadConfig keeps only available Models in agent.models
	const model = config.models.find((m) => modelRef(m) === ref) as Model<Api>;
	const levels = resolveThinking(agent.thinking, model);
	const thinking =
		picked.thinking && levels.allowed.includes(picked.thinking)
			? picked.thinking
			: levels.default;
	return { agent, model, thinking };
}
