// No Node imports: browser code can use this module (as @orqestra/config/shared)
import type { Message } from "@earendil-works/pi-ai";
import { searchProviders, toolNames } from "@orqestra/tools/refs";
import { z } from "zod";

export {
	mcpServerOf,
	mcpToolRef,
	type SearchProviderId,
	searchProviders,
	type ToolName,
	type ToolRef,
} from "@orqestra/tools/refs";

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

/** The largest attachment a User can upload into a Sandbox. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** The largest Skill zip an Admin can upload: 10 MB of files unzipped, stored as they are, plus room for the zip's headers. */
export const SKILL_ZIP_MAX_BYTES = 12 * 1024 * 1024;

/** A message's text, without thinking or tool calls. */
export const messageText = (message: Message) =>
	typeof message.content === "string"
		? message.content
		: message.content.map((c) => (c.type === "text" ? c.text : "")).join("");

export const toolName = z.enum(toolNames);
export const searchProviderId = z.enum(searchProviders.map((p) => p.id));

/** An Agent's id, used in `conversation.agent_id`. */
export const agentId = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes");

/** An MCP Server's id, like an Agent's; never changes, since Agent Definitions and Tool names refer to it. */
export const mcpServerId = agentId;

/** An Agent's Tool entry, as saved in its Definition. */
export const toolRef = z.union([
	toolName,
	z.templateLiteral(["mcp:", mcpServerId]),
]);

/** A name turned into an Agent or MCP Server id; "" when nothing usable is left (e.g. a Chinese name). */
export const slugify = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

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
	/** Omitted means Search and Scrape, never an MCP Server. */
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

/** Why a field of a save was refused, as a code the console translates; `detail` is zod's message for `invalid`. */
export type SaveError =
	| {
			code:
				| "api_key_required"
				| "token_required"
				| "not_in_catalog"
				| "not_found"
				| "id_invalid"
				| "id_taken"
				| "default_required"
				| "default_not_pickable"
				| "skill_zip_invalid"
				| "skill_md_missing"
				| "skill_frontmatter_invalid"
				| "skill_name_invalid"
				| "skill_description_invalid"
				| "skill_too_large"
				| "skill_too_many_files"
				| "skill_exists";
	  }
	| {
			code:
				| "skill_path_unsafe"
				| "skill_symlink"
				| "skill_path_duplicate"
				| "skill_md_nested"
				| "skill_file_binary";
			path: string;
	  }
	| { code: "skill_name_mismatch"; name: string; folder: string }
	| { code: "invalid"; detail: string }
	| {
			code: "header_invalid" | "header_twice" | "header_value_missing";
			header: string;
	  }
	| { code: "default_model_not_allowed"; model: string }
	| { code: "thinking_default_not_allowed"; level: string };

/** Field errors by name or path (`apiKey`, `thinking.default`, …; "" for the whole form); empty when it was saved. */
export type SaveErrors = Record<string, SaveError>;

/** Rules across fields of one definition; "exactly one default" spans all of them and is checked by the caller. */
export function definitionIssues(def: z.infer<typeof agentDefinition>) {
	const issues: { field: string; message: string; error: SaveError }[] = [];
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

/** One of a Skill version's files, its path relative to the Skill's folder (`SKILL.md`, `scripts/…`). */
export type SkillFile = { path: string; content: Uint8Array };

/** Where a Sandbox holds its Skills, one folder each. */
export const SKILLS_DIR = "/workspace/.skills";

/** What a User's message that invokes a Skill becomes: its instructions, then what the User wrote, as pi expands `/skill:name args`. */
export function skillBlock(name: string, body: string, args: string) {
	const block = `<skill name="${name}" location="${SKILLS_DIR}/${name}/SKILL.md">\nReferences are relative to ${SKILLS_DIR}/${name}.\n\n${body}\n</skill>`;
	return args ? `${block}\n\n${args}` : block;
}

/** The Skill a User's text invokes as `/skill:name args`, and the args; undefined when it invokes none. */
export function invokedSkill(text: string) {
	const match = text.match(/^\/skill:(\S+)\s*([\s\S]*)$/);
	return match ? { name: match[1], args: match[2].trim() } : undefined;
}

/** The Skill a User's message invoked and what they wrote with it; undefined when it invokes none. */
export function parseSkillBlock(text: string) {
	// pi's parseSkillBlock pattern
	const match = text.match(
		/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/,
	);
	return match ? { name: match[1], text: match[2]?.trim() ?? "" } : undefined;
}
