// No database at import: what resolves Agent Definitions and Turns, for any process (createAgents is in ./live)

import type { McpServices } from "@orqestra/mcp";
import {
	defaultModelOf,
	type Models,
	modelRef,
	resolveThinking,
	type ThinkingLevel,
} from "@orqestra/models";
import type { SkillInfo } from "@orqestra/skills";
import { availableBuiltinTools, type ToolServices } from "@orqestra/tools";
import {
	mcpToolRef,
	searchToolNames,
	type ToolRef,
} from "@orqestra/tools/shared";
import type { z } from "zod";
import { agentDefinition, definitionIssues } from "./shared.ts";

export interface AgentDefinition {
	id: string;
	name: string;
	description: string;
	/** System prompt: the Markdown body. */
	instructions: string;
	/** As written; only built-in Tools with a Search Provider or Document Parser and available MCP Servers are offered in a Run. */
	tools: ToolRef[];
	/** Allowed Skills by name, as written; a Run gets the available ones from `turnSkills`. */
	skills: string[];
	/** The Model, `<provider>/<id>`, and thinking level it runs on as a Subagent; omitted, its parent's. */
	model?: string;
	thinking?: ThinkingLevel;
	/** Users can start Conversations with it; any Agent can be a Subagent template. */
	pickable: boolean;
	default: boolean;
}

/** The Agents a process offers: every resolved Agent Definition, and the default one. */
export interface AgentsSnapshot {
	agents: AgentDefinition[];
	defaultAgent: AgentDefinition;
}

export class InvalidAgents extends Error {
	override name = "InvalidAgents";
}

/** Resolves the stored Agent Definitions; throws InvalidAgents naming each bad Agent and field. */
export function resolveAgents(
	rows: { id: string; definition: unknown }[],
): AgentsSnapshot {
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
		agents.push({
			...def,
			id: row.id,
			// Parse spends the Document Parser's quota, so an Agent Definition has it only when it lists it
			tools: def.tools ?? [...searchToolNames],
			skills: def.skills ?? [],
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

/**
 * A Subagent's system prompt: its template's instructions, none for the general worker, then whom it works for, which its
 * template, written for talking to Users, does not say. What reaches that agent is the platform's to hand over, not the prompt's.
 */
export const subagentInstructions = (instructions: string) =>
	[
		instructions,
		"You are working as a subagent: another agent gave you one task, and your replies go to that agent.",
	]
		.filter(Boolean)
		.join("\n\n");

/** The built-in Agent a Subagent without a template runs as: Search and Scrape (not Parse), no MCP Server, no Skill. */
const generalWorker: AgentDefinition = {
	id: "",
	name: "General worker",
	description: "",
	instructions: "",
	tools: [...searchToolNames],
	skills: [],
	pickable: false,
	default: false,
};

/**
 * The Agent, Model and thinking level for the next message of a Conversation.
 * A pick no longer enabled falls back to the default Model, the one an Admin marked or else the first enabled.
 * Returns undefined when the Agent was removed or no Model is enabled: the Conversation is then read-only.
 */
export function resolveTurn(
	config: Pick<Models, "models" | "defaultModel"> & {
		agents: AgentDefinition[];
	},
	/** null: the general worker, a Subagent started without a template. */
	agentId: string | null,
	picked: { model?: string; thinking?: ThinkingLevel } = {},
) {
	const agent =
		agentId === null
			? generalWorker
			: config.agents.find((a) => a.id === agentId);
	/** Whatever was picked: it titles the Conversation. */
	const defaultModel = defaultModelOf(config);
	if (!agent || !defaultModel) return undefined;
	const model =
		config.models.find((m) => modelRef(m) === picked.model) ?? defaultModel;
	const levels = resolveThinking(model);
	const thinking =
		picked.thinking && levels.allowed.includes(picked.thinking)
			? picked.thinking
			: levels.default;
	return { agent, model, defaultModel, thinking };
}

/** The Tool entries that can be offered in a Run now: the available built-in Tools, then every MCP Server's Tools. */
export const availableTools = (
	services: ToolServices & McpServices,
): ToolRef[] => [
	...availableBuiltinTools(services),
	...Object.keys(services.mcpServers).map(mcpToolRef),
];

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
