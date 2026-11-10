import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	customType,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	serial,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

// drizzle 0.45 has no bytea column; node-postgres reads it as a Buffer
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
	dataType: () => "bytea",
	toDriver: (value) => Buffer.from(value),
});

// Visible only to its owner: every query filters on userId, Admins included
export const conversation = pgTable(
	"conversation",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		// the owner's Polaris `sub`; Polaris owns the User pool, so there is no local user table
		userId: text("user_id").notNull(),
		// a Subagent's Conversation sits under the one that started it; null for top-level ones
		parentId: uuid("parent_id").references((): AnyPgColumn => conversation.id, {
			onDelete: "cascade",
		}),
		// fixed once the first message is sent; null: the built-in general worker (Subagents only)
		agentId: text("agent_id"),
		// null until generated after the first reply
		title: text("title"),
		titleEdited: boolean("title_edited").default(false).notNull(),
		// "failed" lets the UI offer a retry
		status: text("status")
			.$type<"idle" | "running" | "failed">()
			.default("idle")
			.notNull(),
		// the BullMQ job id of the latest Run, so queueing that Run twice adds one job
		jobId: text("job_id"),
		// Subagents this Conversation's Agent started or continued since the User's last message
		subagentsSinceUser: integer("subagents_since_user").default(0).notNull(),
		// its orrery Sandbox, created the first time its Agent needs one; null until then
		sandboxId: text("sandbox_id"),
		// an Incognito Conversation, chosen when it starts: no memory, and Recall never finds it; false for Subagents, which go by their parent's
		incognito: boolean("incognito").default(false).notNull(),
		// its Runs are Unattended Runs, under the Limits' step and wall-clock caps: an input with an `origin` sets it, a User message clears it; Subagents go by their root's
		unattended: boolean("unattended").default(false).notNull(),
		// a top-level Run ended with a reply the User has yet to open; never set on a Subagent's
		unread: boolean("unread").default(false).notNull(),
		// its last Run ended with a Question (`ask_user`); the User's next message clears it
		awaitingReply: boolean("awaiting_reply").default(false).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("conversation_userId_idx").on(table.userId)],
);

export type InputOrigin = "task" | "timer";

// Completed messages only; a reply is written once it finishes streaming
export const message = pgTable(
	"message",
	{
		id: serial("id").primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		// pi's UserMessage / AssistantMessage as-is, including DeepSeek reasoning_content (thinkingSignature)
		message: jsonb("message").notNull(),
		// `provider/id` and thinking level picked for (user) or used by (assistant) this message
		model: text("model").notNull(),
		thinkingLevel: text("thinking_level").notNull(),
		// a delivered Notification: the Subagent's Conversation it came from
		subagentId: uuid("subagent_id"),
		// as in `inbox`
		origin: text("origin").$type<InputOrigin>(),
		// what Recall searches: a user or assistant message's text, without thinking or Tool calls; null for other messages
		text: text("text").generatedAlwaysAs(sql`message_text(message)`),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("message_conversationId_idx").on(table.conversationId),
		// ILIKE rather than tsvector, which does not segment Chinese
		index("message_text_trgm_idx").using("gin", table.text.op("gin_trgm_ops")),
	],
);

// Every input to a Conversation waits here until its Run delivers it into `message` between two steps
export const inbox = pgTable(
	"inbox",
	{
		id: serial("id").primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		// pi's UserMessage
		message: jsonb("message").notNull(),
		// as in `message`: the Model and thinking level picked for this input
		model: text("model").notNull(),
		thinkingLevel: text("thinking_level").notNull(),
		// set: a Notification from this Subagent's Conversation
		subagentId: uuid("subagent_id"),
		// set: sent on the User's behalf by a Scheduled Task, or delivered by a Timer
		origin: text("origin").$type<InputOrigin>(),
		// false: delivered by the next Run, but does not start one
		wake: boolean("wake").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [index("inbox_conversationId_idx").on(table.conversationId)],
);

// The model sees `summary` plus the messages from firstKeptMessageId on; users still see everything
export const compaction = pgTable(
	"compaction",
	{
		id: serial("id").primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		summary: text("summary").notNull(),
		firstKeptMessageId: integer("first_kept_message_id")
			.notNull()
			.references(() => message.id, { onDelete: "cascade" }),
		tokensBefore: integer("tokens_before").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [index("compaction_conversationId_idx").on(table.conversationId)],
);

// Metadata of a Subagent; its transcript is the `message` rows of its own Conversation, whose parentId and agentId are its parent's and its template
export const subagent = pgTable("subagent", {
	// the Subagent's Conversation
	conversationId: uuid("conversation_id")
		.primaryKey()
		.references(() => conversation.id, { onDelete: "cascade" }),
	// the subagent Tool call that started it, so the UI shows it under that call
	toolCallId: text("tool_call_id").notNull(),
	// what the parent Agent calls it by: 1, 2, ... within the parent Conversation
	number: integer("number").notNull(),
	brief: text("brief").notNull(),
	outcome: text("outcome")
		.$type<
			"queued" | "running" | "completed" | "partial" | "failed" | "stopped"
		>()
		.default("queued")
		.notNull(),
	result: text("result"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

// A User's Memories (ADR 0005); like Conversations, visible only to their owner, Admins included
export const memory = pgTable(
	"memory",
	{
		id: serial("id").primaryKey(),
		// the owner's Polaris `sub`
		userId: text("user_id").notNull(),
		// like a file path: prefs/language
		path: text("path").notNull(),
		description: text("description").notNull(),
		// Markdown
		body: text("body").notNull(),
		// the Conversation that last wrote it; null once that is deleted, since Memories outlive it
		conversationId: uuid("conversation_id").references(() => conversation.id, {
			onDelete: "set null",
		}),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [unique().on(table.userId, table.path)],
);

// A User's memory master switch; no row means on
export const memorySetting = pgTable("memory_setting", {
	// the owner's Polaris `sub`
	userId: text("user_id").primaryKey(),
	// off: the User's Memories stay, but no Agent reads or writes them
	enabled: boolean("enabled").notNull(),
});

// The Limits an Admin set in /console/limits; at most one row, id 1; no row: @orqestra/config's defaults. Durations in seconds
export const limits = pgTable(
	"limits",
	{
		id: integer("id").primaryKey().default(1),
		maxScheduledTasksPerUser: integer("max_scheduled_tasks_per_user").notNull(),
		minFiringInterval: integer("min_firing_interval").notNull(),
		timerRingsPerUserMessage: integer("timer_rings_per_user_message").notNull(),
		unattendedMaxSteps: integer("unattended_max_steps").notNull(),
		unattendedMaxDuration: integer("unattended_max_duration").notNull(),
		maxSubagentDepth: integer("max_subagent_depth").notNull(),
	},
	(table) => [
		check("limits_single_row", sql`${table.id} = 1`),
		check(
			"limits_max_subagent_depth",
			sql`${table.maxSubagentDepth} between 1 and 3`,
		),
	],
);

// Providers an Admin configured from the Catalog; at most one row per Catalog Provider
export const provider = pgTable("provider", {
	// the Catalog (pi) Provider id
	id: text("id").primaryKey(),
	// encrypted with ORQESTRA_ENCRYPTION_KEY; never sent to the browser
	apiKey: text("api_key").notNull(),
	// null: the Catalog's default
	baseUrl: text("base_url"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Kept when the Catalog drops the Model, so it comes back if pi lists it again
export const enabledModel = pgTable(
	"enabled_model",
	{
		providerId: text("provider_id")
			.notNull()
			.references(() => provider.id, { onDelete: "cascade" }),
		modelId: text("model_id").notNull(),
	},
	(table) => [primaryKey({ columns: [table.providerId, table.modelId] })],
);

// Search Providers an Admin configured; at most one row per supported Search Provider
export const searchProvider = pgTable("search_provider", {
	// one of the supported ids (tavily, firecrawl, deepseek)
	id: text("id").primaryKey(),
	// encrypted with ORQESTRA_ENCRYPTION_KEY; never sent to the browser
	apiKey: text("api_key").notNull(),
	// null: the official endpoint; set for a self-hosted service or a reverse proxy
	baseUrl: text("base_url"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

// The Search Provider picked for each built-in Tool; no row, or null: the Tool is unavailable
export const toolService = pgTable("tool_service", {
	// search or scrape
	tool: text("tool").primaryKey(),
	searchProviderId: text("search_provider_id").references(
		() => searchProvider.id,
		{ onDelete: "set null" },
	),
});

// MCP Servers an Admin configured; Agents reach them over Streamable HTTP
export const mcpServer = pgTable("mcp_server", {
	// slug of the name, or typed by the Admin; never changes (Agent Definitions refer to it)
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	// http or https; internal addresses allowed
	url: text("url").notNull(),
	// each value encrypted with ORQESTRA_ENCRYPTION_KEY; never sent to the browser
	headers: jsonb("headers")
		.$type<{ name: string; value: string }[]>()
		.default([])
		.notNull(),
	enabled: boolean("enabled").default(true).notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
});

// The Sandbox Provider (orrery) an Admin configured; at most one row, id "orrery"
export const sandboxProvider = pgTable("sandbox_provider", {
	id: text("id").primaryKey(),
	// orrery's API address, without /api/v1
	url: text("url").notNull(),
	// orrery API Token, encrypted with ORQESTRA_ENCRYPTION_KEY; never sent to the browser
	token: text("token").notNull(),
	// Snapshot name or SnapshotVersion id; null: orrery's default Platform Snapshot
	snapshot: text("snapshot"),
	cpu: doublePrecision("cpu").notNull(),
	// bytes
	memory: bigint("memory", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Agent Definitions edited by Admins in /console/agents; `conversation.agent_id` refers to the id, so it never changes
export const agent = pgTable("agent", {
	id: text("id").primaryKey(),
	// @orqestra/config's agentDefinition, validated on save and on load
	definition: jsonb("definition").notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Skills an Admin uploaded; `name` is the Skill's frontmatter name, which Agent Definitions refer to
export const skill = pgTable("skill", {
	name: text("name").primaryKey(),
	// the version Agents use; set in the transaction that adds the first one
	currentVersionId: integer("current_version_id").references(
		(): AnyPgColumn => skillVersion.id,
	),
	enabled: boolean("enabled").default(true).notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
});

// A full snapshot of a Skill per upload or edit, never changed afterwards (ADR 0004)
export const skillVersion = pgTable(
	"skill_version",
	{
		id: serial("id").primaryKey(),
		skillName: text("skill_name")
			.notNull()
			.references(() => skill.name, { onDelete: "cascade" }),
		// 1, 2, ... within the Skill
		number: integer("number").notNull(),
		// from SKILL.md's frontmatter
		description: text("description").notNull(),
		disableModelInvocation: boolean("disable_model_invocation").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [unique().on(table.skillName, table.number)],
);

export const skillFile = pgTable(
	"skill_file",
	{
		versionId: integer("version_id")
			.notNull()
			.references(() => skillVersion.id, { onDelete: "cascade" }),
		// relative to the Skill's folder: SKILL.md, scripts/…
		path: text("path").notNull(),
		content: bytea("content").notNull(),
	},
	(table) => [primaryKey({ columns: [table.versionId, table.path] })],
);
