import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Api,
	getSupportedThinkingLevels,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type ModelThinkingLevel,
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

// pi also accepts literal keys and "!command"; only env references keep secrets out of the repo
const modelsJsonSchema = z.object({
	providers: z.record(
		z.string(),
		z.looseObject({
			apiKey: z
				.string()
				.regex(
					/^\$(\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)$/,
					'must be an environment variable reference such as "$DEEPSEEK_API_KEY"',
				)
				.optional(),
		}),
	),
});

export interface AgentDefinition {
	/** File name without `.md`. */
	id: string;
	name: string;
	description: string;
	/** System prompt: the Markdown body. */
	instructions: string;
	/** Allowed Models as `provider/id`; every configured Model when the file has no `models`. */
	models: string[];
	defaultModel: string;
	/** As written; resolve per Model with `resolveThinking`. */
	thinking: { default?: ThinkingLevel; allowed?: ThinkingLevel[] };
	compaction?: { reserveTokens?: number; keepRecentTokens?: number };
	default: boolean;
}

export interface OrqestraConfig {
	/** pi registry for models.json; use it to find, authenticate and stream Models. */
	registry: ModelRegistry;
	/** Models of the Providers listed in models.json. */
	models: Model<Api>[];
	providers: { id: string; name: string; keyConfigured: boolean }[];
	agents: AgentDefinition[];
	defaultAgent: AgentDefinition;
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

export const modelRef = (m: { provider: string; id: string }) =>
	`${m.provider}/${m.id}`;

// shortcut: resolves to the repo's config/ from the source tree; a bundled build must set ORQESTRA_CONFIG_DIR
const defaultConfigDir = () =>
	process.env.ORQESTRA_CONFIG_DIR ||
	fileURLToPath(new URL("../../../config", import.meta.url));

/**
 * Loads Providers, Models and Agent Definitions from the config directory
 * (`ORQESTRA_CONFIG_DIR`, default `config/` at the repo root).
 * Throws a ConfigError naming each bad file and field.
 */
export async function loadConfig(
	dir = defaultConfigDir(),
): Promise<OrqestraConfig> {
	const modelsPath = join(dir, "models.json");
	const { registry, providerIds } = await loadRegistry(modelsPath);
	const models = registry
		.getAll()
		.filter((m) => providerIds.includes(m.provider));
	const known = new Set(models.map(modelRef));

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

		agent.models.forEach((ref, i) => {
			if (!known.has(ref)) fail(`models.${i}`, `unknown Model "${ref}"`);
		});
		if (agent.models.length === 0) agent.models = [...known];
		agent.defaultModel ||= process.env.ORQESTRA_DEFAULT_MODEL ?? "";
		if (!agent.defaultModel)
			fail(
				"defaultModel",
				"not set, and neither `models` nor ORQESTRA_DEFAULT_MODEL provides one",
			);
		else if (!agent.models.includes(agent.defaultModel))
			fail(
				"defaultModel",
				`"${agent.defaultModel}" is not one of the Agent's allowed Models`,
			);
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
		providers: providerIds.map((id) => ({
			id,
			name: registry.getProviderDisplayName(id),
			keyConfigured: registry.getProviderAuthStatus(id).configured,
		})),
		agents,
		defaultAgent: defaults[0],
	};
}

async function loadRegistry(modelsPath: string) {
	// pi treats a missing models.json as empty
	if (!existsSync(modelsPath))
		throw new ConfigError(`${modelsPath}: file not found`);
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(modelsPath, "utf8"));
	} catch (e) {
		throw new ConfigError(
			`${modelsPath}: invalid JSON: ${(e as Error).message}`,
		);
	}
	const keys = modelsJsonSchema.safeParse(json);
	if (!keys.success)
		throw new ConfigError(issuesMessage(modelsPath, keys.error));

	// in-memory stores keep pi from reading or writing ~/.pi and files next to models.json
	const runtime = await ModelRuntime.create({
		modelsPath,
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
	const registry = new ModelRegistry(runtime);
	const error = registry.getError();
	if (error) throw new ConfigError(error);
	return { registry, providerIds: Object.keys(keys.data.providers) };
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
	};
}

const issueField = (issue: z.core.$ZodIssue) =>
	[
		...issue.path,
		...(issue.code === "unrecognized_keys" ? [issue.keys.join(", ")] : []),
	].join(".");

const issuesMessage = (path: string, error: z.ZodError) =>
	error.issues
		.map((issue) => `${path}: ${issueField(issue)}: ${issue.message}`)
		.join("\n");

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
 * Returns undefined when the Agent was removed from config: the Conversation is then read-only.
 */
export function resolveTurn(
	config: Pick<OrqestraConfig, "agents" | "models">,
	agentId: string,
	picked: { model?: string; thinking?: ThinkingLevel } = {},
) {
	const agent = config.agents.find((a) => a.id === agentId);
	if (!agent) return undefined;
	const ref =
		picked.model && agent.models.includes(picked.model)
			? picked.model
			: agent.defaultModel;
	// loadConfig only keeps Agents whose Models are configured
	const model = config.models.find((m) => modelRef(m) === ref) as Model<Api>;
	const levels = resolveThinking(agent.thinking, model);
	const thinking =
		picked.thinking && levels.allowed.includes(picked.thinking)
			? picked.thinking
			: levels.default;
	return { agent, model, thinking };
}
