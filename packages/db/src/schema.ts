import {
	type AnyPgColumn,
	boolean,
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

// better-auth tables (core + admin plugin + phoneNumber), shaped as `@better-auth/cli generate` emits them
export const user = pgTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
	role: text("role"),
	banned: boolean("banned").default(false),
	banReason: text("ban_reason"),
	banExpires: timestamp("ban_expires"),
	phoneNumber: text("phone_number"),
});

export const session = pgTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expires_at").notNull(),
		token: text("token").notNull().unique(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.$onUpdate(() => new Date())
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		impersonatedBy: text("impersonated_by"),
	},
	(table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
	"account",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at"),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

// Single row (id = 1) of instance-wide settings editable in /console
export const instanceSettings = pgTable("instance_settings", {
	id: integer("id").primaryKey().default(1),
	allowMemberPassword: boolean("allow_member_password")
		.default(false)
		.notNull(),
	// Set once by Instance Setup and never cleared, so /setup stays closed for good
	setupCompleted: boolean("setup_completed").default(false).notNull(),
	// the Search Provider serving each Tool; null, or one no longer configured: the Tool is unavailable
	searchServedBy: text("search_served_by"),
	scrapeServedBy: text("scrape_served_by"),
});

// Visible only to its owner: every query filters on userId, Admins included
export const conversation = pgTable(
	"conversation",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
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
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("conversation_userId_idx").on(table.userId)],
);

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
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [index("message_conversationId_idx").on(table.conversationId)],
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

// Metadata of a Subagent; its transcript is the `message` rows of its own Conversation
export const subagent = pgTable(
	"subagent",
	{
		// the Subagent's Conversation
		conversationId: uuid("conversation_id")
			.primaryKey()
			.references(() => conversation.id, { onDelete: "cascade" }),
		parentId: uuid("parent_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		// the subagent Tool call that started it, so the UI shows it under that call
		toolCallId: text("tool_call_id").notNull(),
		// what the parent Agent calls it by: 1, 2, ... within the parent Conversation
		number: integer("number").notNull(),
		// Agent Definition id; null for the built-in general worker
		template: text("template"),
		brief: text("brief").notNull(),
		outcome: text("outcome")
			.$type<
				"queued" | "running" | "completed" | "partial" | "failed" | "stopped"
			>()
			.default("queued")
			.notNull(),
		result: text("result"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [unique().on(table.parentId, table.number)],
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

// Agent Definitions edited by Admins in /console/agents; `conversation.agent_id` refers to the id, so it never changes
export const agent = pgTable("agent", {
	id: text("id").primaryKey(),
	// @orqestra/config's agentDefinition, validated on save and on load
	definition: jsonb("definition").notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});
