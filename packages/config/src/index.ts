import type { AgentsSnapshot } from "@orqestra/agents";
// types only: importing @orqestra/mcp would open the database before a test points DATABASE_URL at its own
import type { McpServer, McpServerSettings } from "@orqestra/mcp";
import {
	type ModelSettings,
	type Models,
	resolveModels,
} from "@orqestra/models";
import type { SkillInfo } from "@orqestra/skills";
import type { SandboxProvider, ToolServices } from "@orqestra/tools";
import {
	type SearchProviderId,
	type SearchToolName,
	type SpendingLimit,
	searchProviders,
	searchToolNames,
} from "./shared.ts";

// shortcut: re-exported until callers import them from @orqestra/agents (#132)
export {
	type AgentDefinition,
	GENERAL_WORKER,
	resolveTurn,
	turnSkills,
} from "@orqestra/agents";
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

/** What an Admin configured in /console, as stored in the database. */
export interface Settings extends ModelSettings {
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
	mcpServers: McpServerSettings;
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

export interface OrqestraConfig extends Models, AgentsSnapshot {
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

/** Resolves the stored Search Providers, Document Parser, MCP Servers, Sandbox Provider and Limits against the configured Models. */
export const loadConfig = async (settings: Settings) =>
	resolveConfig(settings, await resolveModels(settings));

/** `loadConfig` on Models resolved by the models package, as `createConfig` does with its snapshot. */
export function resolveConfig(
	settings: Omit<Settings, keyof ModelSettings>,
	loaded: Models,
): Omit<OrqestraConfig, "skills" | keyof AgentsSnapshot> {
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
		tools,
		mcpServers,
		allMcpServers,
		sandboxProvider,
		limits: settings.limits ?? DEFAULT_LIMITS,
	};
}
