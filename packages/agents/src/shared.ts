// No Node imports: browser code can use this module (as @orqestra/agents/shared)
import { toolName } from "@orqestra/tools/shared";
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

// strict: an Agent Definition only says who the Agent is (ADR 0012); the Model, thinking level and memory are the User's to pick
/** An Agent Definition as stored in the database (and edited in /console/agents), without its id. */
export const agentDefinition = z.strictObject({
	name: z.string().trim().min(1),
	description: z.string().trim().min(1),
	/** The system prompt, Markdown. */
	instructions: z.string(),
	/** Omitted means Search and Scrape, never Parse or an MCP Server. */
	tools: z.array(toolRef).optional(),
	/** Allowed Skills by name; omitted means none. */
	skills: z.array(z.string()).optional(),
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
	| { code: "invalid"; detail: string };

/** Rules across fields of one definition; "exactly one default" spans all of them and is checked by the caller. */
export function definitionIssues(def: z.infer<typeof agentDefinition>) {
	const issues: { field: string; message: string; error: AgentSaveError }[] =
		[];
	if (def.default && !def.pickable)
		issues.push({
			field: "pickable",
			message: "the default Agent must be pickable by Users",
			error: { code: "default_not_pickable" },
		});
	return issues;
}

/** A name turned into an Agent or MCP Server id; "" when nothing usable is left (e.g. a Chinese name). */
export const slugify = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
