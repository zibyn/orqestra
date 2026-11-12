// No Node imports: browser code can use this module (as @orqestra/config/shared)
import type { Message } from "@earendil-works/pi-ai";
import { agentId } from "@orqestra/agents/shared";
import type { SkillError } from "@orqestra/skills/shared";
import {
	searchProviders,
	searchToolNames,
	toolNames,
} from "@orqestra/tools/refs";
import { z } from "zod";

// shortcut: re-exported until callers import them from @orqestra/agents/shared (#132)
export {
	type AgentDefinitionInput,
	agentDefinition,
	agentId,
	definitionIssues,
	thinkingLevel,
	toolRef,
} from "@orqestra/agents/shared";
export * from "@orqestra/skills/shared";

export {
	isMineruNet,
	MINERU_URL,
	mcpServerOf,
	mcpToolRef,
	type SearchProviderId,
	type SearchToolName,
	searchProviders,
	searchToolNames,
	type ToolName,
	type ToolRef,
} from "@orqestra/tools/refs";

/** A Spending Limit: none, or so many dollars a calendar month; $0 lets nothing be spent. */
export const spendingLimit = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("unlimited") }),
	z.object({ mode: z.literal("limited"), usd: z.number().nonnegative() }),
]);
export type SpendingLimit = z.infer<typeof spendingLimit>;

/** A User's own Spending Limit, or `default`: the Limits' default for everyone. */
export const userSpendingLimit = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("default") }),
	...spendingLimit.options,
]);
export type UserSpendingLimit = z.infer<typeof userSpendingLimit>;

/** An IANA time zone name this runtime knows. */
export const timeZone = z.string().refine((zone) => {
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}, "not a time zone");

/** The largest attachment a User can upload into a Sandbox. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** A message's text, without thinking or tool calls. */
export const messageText = (message: Message) =>
	typeof message.content === "string"
		? message.content
		: message.content.map((c) => (c.type === "text" ? c.text : "")).join("");

export const toolName = z.enum(toolNames);
export const searchToolName = z.enum(searchToolNames);
export const searchProviderId = z.enum(searchProviders.map((p) => p.id));

/** An MCP Server's id, like an Agent's; never changes, since Agent Definitions and Tool names refer to it. */
export const mcpServerId = agentId;

/** A name turned into an Agent or MCP Server id; "" when nothing usable is left (e.g. a Chinese name). */
export const slugify = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

/** Why a field of a save was refused, as a code the console translates; `detail` is zod's message for `invalid`. */
export type SaveError =
	| {
			code:
				| "api_key_required"
				| "token_required"
				| "not_in_catalog"
				| "model_not_enabled"
				| "not_found"
				| "id_invalid"
				| "id_taken"
				| "default_required"
				| "default_not_pickable"
				| "server_disabled"
				| "connection_exists"
				| "oauth_client_required";
	  }
	| SkillError
	| { code: "invalid" | "oauth_unavailable"; detail: string }
	| {
			code:
				| "header_invalid"
				| "header_twice"
				| "header_value_missing"
				| "header_reserved";
			header: string;
	  }
	| { code: "default_model_not_allowed"; model: string }
	| { code: "thinking_default_not_allowed"; level: string };

/** Field errors by name or path (`apiKey`, `thinking.default`, …; "" for the whole form); empty when it was saved. */
export type SaveErrors = Record<string, SaveError>;

/** The Memory Tools whose calls change a Memory, and can be undone. */
export const MEMORY_CHANGES = [
	"memory_write",
	"memory_edit",
	"memory_delete",
] as const;
export type MemoryChange = (typeof MEMORY_CHANGES)[number];
