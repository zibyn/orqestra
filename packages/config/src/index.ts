import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ModelSettings,
	type Models,
	modelRef,
	resolveModels,
	resolveThinking,
	type ThinkingLevel,
} from "@orqestra/models";
import type { SkillInfo } from "@orqestra/skills";
import type { McpServer, SandboxProvider, ToolServices } from "@orqestra/tools";
import type { z } from "zod";
import {
	agentDefinition,
	definitionIssues,
	type SearchProviderId,
	type SearchToolName,
	type SpendingLimit,
	searchProviders,
	searchToolNames,
	type ToolRef,
} from "./shared.ts";

// shortcut: re-exported until callers import them from @orqestra/models (#122)
export {
	catalogProviders,
	modelRef,
	priceInForce,
	pricesByModel,
	resolveThinking,
	type ThinkingLevel,
	testConnection,
} from "@orqestra/models";
export { type SkillInfo, skillInstructions } from "@orqestra/skills";
export * from "./shared.ts";

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
	/** As written; only built-in Tools with a Search Provider or Document Parser and available MCP Servers are offered in a Run. */
	tools: ToolRef[];
	/** Allowed Skills by name, as written; a Run gets the available ones from `turnSkills`. */
	skills: string[];
	/** Its Runs get the Memory Tools, the Memory Index and the memory instructions. */
	memory: boolean;
	/** Users can start Conversations with it; any Agent can be a Subagent template. */
	pickable: boolean;
	default: boolean;
	/** Models the definition names that are not available (disabled, deleted, or gone from the Catalog), as `provider/id`. */
	unavailableModels: string[];
}

/** What an Admin configured in /console, as stored in the database. */
export interface Settings extends ModelSettings {
	/** Agent Definitions as stored, validated by `loadConfig`. */
	agents: { id: string; definition: unknown }[];
	/** `apiKey` is undefined when the stored key cannot be decrypted; `baseUrl` null means the official one. */
	searchProviders: {
		id: SearchProviderId;
		apiKey: string | undefined;
		baseUrl: string | null;
	}[];
	/** The Search Provider picked for each Tool. */
	servedBy: Record<SearchToolName, SearchProviderId | null>;
	/** Omitted when none is configured; `apiKey` is null when none is stored, undefined when it cannot be decrypted. */
	documentParser?: {
		enabled: boolean;
		url: string;
		apiKey: string | null | undefined;
	};
	/** A header `value` is undefined when it cannot be decrypted. */
	mcpServers: {
		id: string;
		name: string;
		url: string;
		enabled: boolean;
		auth: "shared" | "oauth";
		/** `client_secret` is undefined when there is none or it cannot be decrypted. */
		oauthClient?: {
			client_id: string;
			client_secret: string | undefined;
		} | null;
		headers: { name: string; value: string | undefined }[];
	}[];
	/** Omitted when none is configured; `token` is undefined when it cannot be decrypted, `snapshot` null means orrery's default. */
	sandboxProvider?: {
		url: string;
		token: string | undefined;
		snapshot: string | null;
		cpu: number;
		memory: number;
	};
	/** Omitted when none were saved: DEFAULT_LIMITS. */
	limits?: Limits;
}

/** The Limits an Admin sets in /console/limits; durations in seconds. */
export interface Limits {
	maxScheduledTasksPerUser: number;
	/** The shortest interval between two Firings of a recurring Scheduled Task. */
	minFiringInterval: number;
	timerRingsPerUserMessage: number;
	/** Model requests an Unattended Run may make; the last one, without Tools, is for its final answer. */
	unattendedMaxSteps: number;
	/** Wall-clock time an Unattended Run may take before it is aborted. */
	unattendedMaxDuration: number;
	/** 1 to 3. */
	maxSubagentDepth: number;
	/** The default Spending Limit, every User's unless they have their own. */
	spendingLimit: SpendingLimit;
	/** The IANA time zone whose calendar months Spending Limits cover. */
	resetTimeZone: string;
	/** How long a Background Call is tracked before it is cancelled and ends failed. */
	backgroundCallMaxDuration: number;
}

/** The Limits until an Admin saves them. */
export const DEFAULT_LIMITS: Limits = {
	maxScheduledTasksPerUser: 10,
	minFiringInterval: 60 * 60,
	timerRingsPerUserMessage: 10,
	unattendedMaxSteps: 50,
	unattendedMaxDuration: 30 * 60,
	maxSubagentDepth: 2,
	spendingLimit: { mode: "unlimited" },
	resetTimeZone: "UTC",
	backgroundCallMaxDuration: 24 * 60 * 60,
};

export interface OrqestraConfig extends Models {
	agents: AgentDefinition[];
	defaultAgent: AgentDefinition;
	/** Tools with a usable Search Provider or Document Parser; the others are unavailable. */
	tools: ToolServices["tools"];
	/** Enabled MCP Servers whose headers decrypt, by id; the others are unavailable. */
	mcpServers: Record<string, McpServer>;
	/** Every MCP Server whose headers decrypt, disabled ones included, by id: what deleting one cancels its Background Calls with. */
	allMcpServers: Record<string, McpServer>;
	/** Enabled Skills, by name; the others are unavailable. */
	skills: Record<string, SkillInfo>;
	/** Undefined when none is configured or its token cannot be decrypted: every Skill is then unavailable. */
	sandboxProvider?: SandboxProvider;
	limits: Limits;
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

/**
 * Resolves the stored Agent Definitions against the configured Providers, Models and Search Providers.
 * Throws a ConfigError naming each bad Agent and field; a Model that is not available only warns.
 */
export const loadConfig = async (settings: Settings) =>
	resolveConfig(settings, await resolveModels(settings));

/** `loadConfig` on Models resolved by the models package, as `createConfig` does with its snapshot. */
export function resolveConfig(
	settings: Omit<Settings, keyof ModelSettings>,
	loaded: Models,
): Omit<OrqestraConfig, "skills"> {
	const { models } = loaded;
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
		const {
			models: named,
			defaultModel,
			thinking,
			tools,
			skills,
			...rest
		} = def;
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
			// Parse spends the Document Parser's quota, so an Agent Definition has it only when it lists it
			tools: tools ?? [...searchToolNames],
			skills: skills ?? [],
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
	for (const tool of searchToolNames) {
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
	const parser = settings.documentParser;
	if (parser?.enabled && parser.apiKey !== undefined)
		tools.parse = { baseUrl: parser.url, apiKey: parser.apiKey ?? "" };

	const mcpServers: OrqestraConfig["mcpServers"] = {};
	const allMcpServers: OrqestraConfig["allMcpServers"] = {};
	for (const {
		id,
		name,
		url,
		enabled,
		auth,
		oauthClient,
		headers,
	} of settings.mcpServers) {
		const plain = headers.flatMap((h) =>
			h.value === undefined ? [] : [[h.name, h.value]],
		);
		// one unreadable header: the server would reject us, so it is unavailable
		if (plain.length !== headers.length) continue;
		allMcpServers[id] = {
			name,
			url,
			auth,
			...(oauthClient && { oauthClient }),
			headers: Object.fromEntries(plain),
		};
		if (enabled) mcpServers[id] = allMcpServers[id];
	}

	const stored = settings.sandboxProvider;
	const sandboxProvider = stored?.token
		? { ...stored, token: stored.token, snapshot: stored.snapshot ?? undefined }
		: undefined;

	return {
		...loaded,
		agents,
		defaultAgent: defaults[0],
		tools,
		mcpServers,
		allMcpServers,
		sandboxProvider,
		limits: settings.limits ?? DEFAULT_LIMITS,
	};
}

const issueField = (issue: z.core.$ZodIssue) =>
	[
		...issue.path,
		...(issue.code === "unrecognized_keys" ? [issue.keys.join(", ")] : []),
	].join(".");

/** System prompt of the general worker. */
export const GENERAL_WORKER =
	"You carry out one task for another agent, starting without any prior context. Work through it with the tools you have, then reply with a complete, self-contained answer: it is all the other agent will see.";

/** The built-in Agent a Subagent without a template runs as: any enabled Model, Search and Scrape (not Parse), no MCP Server, no Skill. */
const generalWorker = (models: Model<Api>[]): AgentDefinition => ({
	id: "",
	name: "General worker",
	description: "",
	instructions: GENERAL_WORKER,
	models: models.map(modelRef),
	allModels: true,
	defaultModel: models[0] ? modelRef(models[0]) : "",
	thinking: {},
	tools: [...searchToolNames],
	skills: [],
	memory: false,
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

/** The Skills a Run of `agent` offers: those it allows that are enabled, none without a Sandbox Provider. */
export const turnSkills = (
	config: Pick<OrqestraConfig, "skills" | "sandboxProvider">,
	agent: Pick<AgentDefinition, "skills">,
) =>
	config.sandboxProvider
		? agent.skills.flatMap((name) => {
				const skill = config.skills[name];
				return skill ? [{ name, ...skill }] : [];
			})
		: [];
