// No Node imports: browser code can use this module (as @orqestra/agents/shared)
import { toolName } from "@orqestra/tools/refs";
import { z } from "zod";

/** Every thinking level pi knows; which ones a Model offers is narrowed by `resolveThinking`. */
export const thinkingLevel = z.enum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/** An Agent's id, used in `conversation.agent_id`. */
export const agentId = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes");

/** An Agent's Tool entry, as saved in its Definition: a built-in Tool, or `mcp:<id>` with an MCP Server's id (like an Agent's). */
export const toolRef = z.union([
	toolName,
	z.templateLiteral(["mcp:", agentId]),
]);

// strict: an Agent Definition must not carry Conversation- or User-specific fields, so it can back a Subagent
/** An Agent Definition as stored in the database (and edited in /console/agents), without its id. */
export const agentDefinition = z.strictObject({
	name: z.string().trim().min(1),
	description: z.string().trim().min(1),
	/** The system prompt, Markdown. */
	instructions: z.string(),
	/** Allowed Models as `provider/id`; omitted means every enabled Model. */
	models: z.array(z.string()).min(1).optional(),
	defaultModel: z.string().optional(),
	thinking: z
		.strictObject({
			default: thinkingLevel.optional(),
			allowed: z.array(thinkingLevel).min(1).optional(),
		})
		.optional(),
	/** Omitted means Search and Scrape, never Parse or an MCP Server. */
	tools: z.array(toolRef).optional(),
	/** Allowed Skills by name; omitted means none. */
	skills: z.array(z.string()).optional(),
	compaction: z
		.strictObject({
			reserveTokens: z.number().int().positive().optional(),
			keepRecentTokens: z.number().int().positive().optional(),
		})
		.optional(),
	/** Its Runs read and write the User's Memories; Admins turn it on per Agent. */
	memory: z.boolean().default(false),
	/** Users can start Conversations with it; otherwise it only serves as a Subagent template. */
	pickable: z.boolean().default(true),
	default: z.boolean().default(false),
});
export type AgentDefinitionInput = z.input<typeof agentDefinition>;

/** Why a field of an Agent Definition's save was refused, as a code the console translates; `detail` is zod's message for `invalid`. */
export type AgentSaveError =
	| {
			code:
				| "not_found"
				| "id_taken"
				| "default_required"
				| "default_not_pickable";
	  }
	| { code: "invalid"; detail: string }
	| { code: "default_model_not_allowed"; model: string }
	| { code: "thinking_default_not_allowed"; level: string };

/** Rules across fields of one definition; "exactly one default" spans all of them and is checked by the caller. */
export function definitionIssues(def: z.infer<typeof agentDefinition>) {
	const issues: { field: string; message: string; error: AgentSaveError }[] =
		[];
	if (def.models && def.defaultModel && !def.models.includes(def.defaultModel))
		issues.push({
			field: "defaultModel",
			message: `"${def.defaultModel}" is not one of the Agent's allowed Models`,
			error: { code: "default_model_not_allowed", model: def.defaultModel },
		});
	const { default: level, allowed } = def.thinking ?? {};
	if (level && allowed && !allowed.includes(level))
		issues.push({
			field: "thinking.default",
			message: `"${level}" is not in thinking.allowed`,
			error: { code: "thinking_default_not_allowed", level },
		});
	if (def.default && !def.pickable)
		issues.push({
			field: "pickable",
			message: "the default Agent must be pickable by Users",
			error: { code: "default_not_pickable" },
		});
	return issues;
}
