import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
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
});

// Visible only to its owner: every query filters on userId, Admins included
export const conversation = pgTable(
	"conversation",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// fixed once the first message is sent
		agentId: text("agent_id").notNull(),
		// null until generated after the first reply
		title: text("title"),
		titleEdited: boolean("title_edited").default(false).notNull(),
		// "failed" lets the UI offer a retry
		status: text("status")
			.$type<"idle" | "running" | "failed">()
			.default("idle")
			.notNull(),
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
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [index("message_conversationId_idx").on(table.conversationId)],
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
