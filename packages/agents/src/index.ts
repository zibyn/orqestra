// No database at import: what resolves Agent Definitions and Turns, for any process (createAgents is in ./live)
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type Models,
	modelRef,
	resolveThinking,
	type ThinkingLevel,
} from "@orqestra/models";
import type { SkillInfo } from "@orqestra/skills";
import { searchToolNames, type ToolRef } from "@orqestra/tools/shared";
import type { z } from "zod";
import { agentDefinition, definitionIssues } from "./shared.ts";

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

/** The Agents a process offers: every resolved Agent Definition, and the default one. */
export interface AgentsSnapshot {
	agents: AgentDefinition[];
	defaultAgent: AgentDefinition;
}

export class InvalidAgents extends Error {
	override name = "InvalidAgents";
}

/**
 * Resolves the stored Agent Definitions against the enabled Models.
 * Throws InvalidAgents naming each bad Agent and field; a Model that is not available is only listed in `unavailableModels`.
 */
export function resolveAgents(
	rows: { id: string; definition: unknown }[],
	{ models }: Pick<Models, "models">,
): AgentsSnapshot {
	const known = models.map(modelRef);

	const errors: string[] = [];
	const agents: AgentDefinition[] = [];
	for (const row of rows) {
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
		throw new InvalidAgents(`Invalid configuration:\n  ${errors.join("\n  ")}`);
	return { agents, defaultAgent: defaults[0] };
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
 * Returns undefined when the Agent was removed or has no Model left: the Conversation is then read-only.
 */
export function resolveTurn(
	config: { agents: AgentDefinition[]; models: Model<Api>[] },
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
	// resolveAgents keeps only available Models in agent.models
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
	config: { skills: Record<string, SkillInfo>; sandboxProvider?: unknown },
	agent: Pick<AgentDefinition, "skills">,
) =>
	config.sandboxProvider
		? agent.skills.flatMap((name) => {
				const skill = config.skills[name];
				return skill ? [{ name, ...skill }] : [];
			})
		: [];
