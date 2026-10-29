// No Node imports: browser code can use this module (as @orqestra/config/shared)
import type { Message } from "@earendil-works/pi-ai";
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

/** A message's text, without thinking or tool calls. */
export const messageText = (message: Message) =>
	typeof message.content === "string"
		? message.content
		: message.content.map((c) => (c.type === "text" ? c.text : "")).join("");

/** The Tools an Agent can call; which Search Provider serves each is picked in /console. */
export const toolName = z.enum(["search", "scrape"]);
export type ToolName = z.infer<typeof toolName>;

/** The Search Providers Orqestra supports, with their official baseUrl; each can be configured at most once. */
export const searchProviders = [
	{ id: "tavily", name: "Tavily", baseUrl: "https://api.tavily.com" },
	{ id: "firecrawl", name: "Firecrawl", baseUrl: "https://api.firecrawl.dev" },
	{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
] as const;
export const searchProviderId = z.enum(searchProviders.map((p) => p.id));
export type SearchProviderId = z.infer<typeof searchProviderId>;

/** An Agent's id, used in `conversation.agent_id`. */
export const agentId = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes");

/** An MCP Server's id, like an Agent's; never changes, since Agent Definitions and Tool names refer to it. */
export const mcpServerId = agentId;

/** An Agent's Tool entry: a built-in Tool, or `mcp:<serverId>` for every Tool of that MCP Server. */
export const agentTool = z.union([
	toolName,
	z.templateLiteral(["mcp:", mcpServerId]),
]);
export type AgentTool = z.infer<typeof agentTool>;

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
	tools: z.array(agentTool).optional(),
	compaction: z
		.strictObject({
			reserveTokens: z.number().int().positive().optional(),
			keepRecentTokens: z.number().int().positive().optional(),
		})
		.optional(),
	/** Users can start Conversations with it; otherwise it only serves as a Subagent template. */
	pickable: z.boolean().default(true),
	default: z.boolean().default(false),
});
export type AgentDefinitionInput = z.input<typeof agentDefinition>;

/** Rules across fields of one definition, as `field: message`; "exactly one default" spans all of them and is checked by the caller. */
export function definitionIssues(def: z.infer<typeof agentDefinition>) {
	const issues: { field: string; message: string }[] = [];
	if (def.models && def.defaultModel && !def.models.includes(def.defaultModel))
		issues.push({
			field: "defaultModel",
			message: `"${def.defaultModel}" is not one of the Agent's allowed Models`,
		});
	const { default: level, allowed } = def.thinking ?? {};
	if (level && allowed && !allowed.includes(level))
		issues.push({
			field: "thinking.default",
			message: `"${level}" is not in thinking.allowed`,
		});
	if (def.default && !def.pickable)
		issues.push({
			field: "pickable",
			message: "the default Agent must be pickable by Users",
		});
	return issues;
}

/** The Agent written into an empty database. */
export const generalAgent: AgentDefinitionInput = {
	name: "General",
	description: "A general-purpose assistant for everyday questions and tasks.",
	instructions:
		"You are a helpful, honest assistant. Answer clearly and concisely, ask a short\nclarifying question when a request is ambiguous, and say so when you are not sure.",
	models: ["deepseek/deepseek-flash"],
	thinking: { default: "low" },
	pickable: true,
	default: true,
};
