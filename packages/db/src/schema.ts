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

/** Why a Run failed: the User's Spending Limit was used up, or anything else. */
export type RunFailure = "spending_limit" | "error";

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
		// the top-level Conversation of its tree (itself for a top-level one) and how deep it sits under it;
		// the conversation_tree trigger sets both from parentId on insert
		rootId: uuid("root_id")
			.notNull()
			.references((): AnyPgColumn => conversation.id, { onDelete: "cascade" })
			.$defaultFn(() => sql`null`),
		depth: integer("depth").default(0).notNull(),
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
		// why the last Run failed, for the UI's text; meaningful only while status is "failed"
		failure: text("failure").$type<RunFailure>(),
		// the BullMQ job id of the latest Run, so queueing that Run twice adds one job
		jobId: text("job_id"),
		// the job of a Run the User stopped: one a worker took before it heard the Stop learns of it here
		stoppedJobId: text("stopped_job_id"),
		// on a root: Subagents its tree's Agents started or continued since the User's last message
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
		// a Firing of this Scheduled Task started it: it shows under the task, not in the ordinary list; null again once the task is deleted
		scheduledTaskId: uuid("scheduled_task_id").references(
			(): AnyPgColumn => scheduledTask.id,
			{ onDelete: "set null" },
		),
		// Timers that rang since the User's last message, which only so many may (the Limits' timer_rings_per_user_message)
		timerRingsSinceUser: integer("timer_rings_since_user").default(0).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index("conversation_userId_idx").on(table.userId),
		index("conversation_scheduledTaskId_idx").on(table.scheduledTaskId),
		index("conversation_rootId_idx").on(table.rootId),
	],
);

export type InputOrigin = "task" | "timer";

/** When a Scheduled Task fires: once at an ISO time, every so many seconds, or by a cron expression in the task's time zone. */
export type Schedule =
	| { kind: "once"; at: string }
	| { kind: "every"; seconds: number }
	| { kind: "cron"; expr: string };

// A User's Scheduled Tasks; like Conversations, visible only to their owner, Admins included
export const scheduledTask = pgTable(
	"scheduled_task",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		// the owner's Polaris `sub`
		userId: text("user_id").notNull(),
		name: text("name").notNull(),
		prompt: text("prompt").notNull(),
		agentId: text("agent_id").notNull(),
		// `provider/id`
		model: text("model").notNull(),
		thinkingLevel: text("thinking_level").notNull(),
		schedule: jsonb("schedule").$type<Schedule>().notNull(),
		// recurring tasks only: no Firing after it
		endsAt: timestamp("ends_at", { withTimezone: true }),
		// IANA; a cron expression is read in it
		timeZone: text("time_zone").notNull(),
		incognito: boolean("incognito").notNull(),
		alertOnComplete: boolean("alert_on_complete").default(true).notNull(),
		// active: it fires; paused by the User; auto_paused by three failed Firings in a row; finished: fired once, or ran past ends_at
		state: text("state")
			.$type<"active" | "paused" | "auto_paused" | "finished">()
			.notNull(),
		// failed Firings since the last one that was not; skipped ones do not count
		consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("scheduled_task_userId_idx").on(table.userId)],
);

export type FiringOutcome =
	| "running"
	| "completed"
	| "partial"
	| "question"
	| "skipped"
	| "failed";

// One row per Firing of a Scheduled Task, gone with it
export const firing = pgTable(
	"firing",
	{
		id: serial("id").primaryKey(),
		taskId: uuid("task_id")
			.notNull()
			.references(() => scheduledTask.id, { onDelete: "cascade" }),
		firedAt: timestamp("fired_at").defaultNow().notNull(),
		// running until its Conversation's Run ends with its whole tree done (every Subagent and Background Call), then how that Run ended
		outcome: text("outcome").$type<FiringOutcome>().notNull(),
		// why it was skipped or failed before starting a Conversation: previous_running, spending_limit, agent_unavailable or model_disabled
		reason: text("reason"),
		// null when it was skipped, or failed before starting one
		conversationId: uuid("conversation_id").references(() => conversation.id, {
			onDelete: "set null",
		}),
	},
	(table) => [
		index("firing_taskId_idx").on(table.taskId),
		index("firing_conversationId_idx").on(table.conversationId),
	],
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
		// a delivered Notification: the Background Call it reports on
		backgroundCallId: uuid("background_call_id"),
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

// A file that goes with a message; its bytes are in object storage at `key` (ADR 0007)
export const attachment = pgTable(
	"attachment",
	{
		id: serial("id").primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		// unique in the Conversation: the path it is copied to in the Sandbox, /workspace/uploads/<name>
		name: text("name").notNull(),
		size: integer("size").notNull(),
		key: text("key").notNull(),
		// the message it belongs to, once one is saved; a User's upload goes with its message through the Inbox, and keeps none
		messageId: integer("message_id").references(() => message.id, {
			onDelete: "cascade",
		}),
		// false: uploaded, but not yet sent with a message
		sent: boolean("sent").default(false).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		unique().on(table.conversationId, table.name),
		// deleting a message (a retry does) finds its Attachments
		index("attachment_messageId_idx").on(table.messageId),
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
		// set: a Notification of how this Background Call ended
		backgroundCallId: uuid("background_call_id"),
		// set: sent on the User's behalf by a Scheduled Task, or delivered by a Timer
		origin: text("origin").$type<InputOrigin>(),
		// false: delivered by the next Run, but does not start one
		wake: boolean("wake").notNull(),
		// the W3C trace context of the Tool call that set it going: the Run it wakes goes under `parent` (a Subagent's brief) or links to `link`
		trace: jsonb("trace").$type<{
			parent?: Record<string, string>;
			link?: Record<string, string>;
		}>(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [index("inbox_conversationId_idx").on(table.conversationId)],
);

// The Timer a top-level Conversation's Agent set, at most one: it rings at rings_at unless this row is gone or replaced by then
export const timer = pgTable("timer", {
	conversationId: uuid("conversation_id")
		.primaryKey()
		.references(() => conversation.id, { onDelete: "cascade" }),
	// the Agent's note to itself, delivered as its input when it rings
	note: text("note").notNull(),
	ringsAt: timestamp("rings_at", { withTimezone: true }).notNull(),
	// the Conversation's latest message when it was set, in the Turn that set it: Retry dropping that Turn drops the Timer
	messageId: integer("message_id")
		.notNull()
		.references(() => message.id, { onDelete: "cascade" }),
	// the Turn's that set it, for the input it delivers
	model: text("model").notNull(),
	thinkingLevel: text("thinking_level").notNull(),
});

/** How a Background Call stands: running until it ends one of the other ways. */
export type BackgroundCallStatus =
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

// A Tool call its MCP Server put in the background: polled until it ends, when its outcome comes to the Conversation as a Notification
export const backgroundCall = pgTable(
	"background_call",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		// the Conversation whose Agent made the call, and gets the Notification
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		// the Tool call it answers, so the UI shows it under that call
		toolCallId: text("tool_call_id").notNull(),
		// no foreign key: polled with the server's current config, its deletion handled apart
		mcpServerId: text("mcp_server_id").notNull(),
		// the Tool's name on its MCP Server
		toolName: text("tool_name").notNull(),
		// ext-tasks' SerializedTaskReference, to resume the task by
		reference: jsonb("reference").notNull(),
		status: text("status")
			.$type<BackgroundCallStatus>()
			.default("running")
			.notNull(),
		// the BullMQ job id of its next poll, so queueing that poll twice adds one job
		jobId: text("job_id").notNull(),
		// as the Timer's: the Conversation's latest message when it started, in the Turn that made it
		messageId: integer("message_id")
			.notNull()
			.references(() => message.id, { onDelete: "cascade" }),
		startedAt: timestamp("started_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		// when the server last answered a poll; the start until it has
		polledAt: timestamp("polled_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		// the W3C trace context of the Tool call that made it, which the Run its Notification wakes links to
		trace: jsonb("trace").$type<Record<string, string>>(),
	},
	(table) => [
		index("background_call_conversationId_idx").on(table.conversationId),
	],
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
	// the W3C trace context of the Tool call that started or last continued it, which its Notification's Run links to
	trace: jsonb("trace").$type<Record<string, string>>(),
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

// A User who has used Orqestra (ADR 0008), written when a signed-in request reads the session; kept when Polaris removes them.
// Roles and Entitlements stay in Polaris: whether a User is an Admin is read from the access token on every request
export const user = pgTable("user", {
	// their Polaris `sub`
	id: text("id").primaryKey(),
	// from the token's claims, rewritten only when they change
	name: text("name").notNull(),
	email: text("email"),
	// moved at most hourly
	lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull(),
	// default: the Limits' default for everyone
	spendingLimit: jsonb("spending_limit")
		.$type<SpendingLimit | { mode: "default" }>()
		.default({ mode: "default" })
		.notNull(),
});

// A browser that receives the User's Alerts by Web Push: one row per browser
export const pushSubscription = pgTable(
	"push_subscription",
	{
		id: serial("id").primaryKey(),
		// the owner's Polaris `sub`
		userId: text("user_id").notNull(),
		// the push service's URL for this browser; a browser signed in as another User moves it to them
		endpoint: text("endpoint").notNull().unique(),
		keys: jsonb("keys").$type<{ p256dh: string; auth: string }>().notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [index().on(table.userId)],
);

// A User's memory master switch; no row means on
export const memorySetting = pgTable("memory_setting", {
	// the owner's Polaris `sub`
	userId: text("user_id").primaryKey(),
	// off: the User's Memories stay, but no Agent reads or writes them
	enabled: boolean("enabled").notNull(),
});

/** None, or so many dollars a calendar month. */
export type SpendingLimit =
	| { mode: "unlimited" }
	| { mode: "limited"; usd: number };

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
		spendingLimit: jsonb("spending_limit")
			.$type<SpendingLimit>()
			.default({ mode: "unlimited" })
			.notNull(),
		resetTimeZone: text("reset_time_zone").default("UTC").notNull(),
		backgroundCallMaxDuration: integer("background_call_max_duration")
			.default(86400)
			.notNull(),
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

// An Admin's price for a Model, replacing the Catalog's as a whole; not tied to enabled_model, so disabling the Model keeps it
export const modelPrice = pgTable(
	"model_price",
	{
		providerId: text("provider_id")
			.notNull()
			.references(() => provider.id, { onDelete: "cascade" }),
		modelId: text("model_id").notNull(),
		// US dollars per million tokens, as the Catalog's
		input: doublePrecision("input").notNull(),
		output: doublePrecision("output").notNull(),
		cacheRead: doublePrecision("cache_read").notNull(),
		cacheWrite: doublePrecision("cache_write").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.providerId, table.modelId] }),
		check(
			"model_price_non_negative",
			sql`${table.input} >= 0 and ${table.output} >= 0 and ${table.cacheRead} >= 0 and ${table.cacheWrite} >= 0`,
		),
	],
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

// The Document Parser (MinerU) an Admin configured; at most one row, id "mineru"
export const documentParser = pgTable("document_parser", {
	id: text("id").primaryKey(),
	enabled: boolean("enabled").default(true).notNull(),
	// mineru.net, or a self-hosted MinerU
	url: text("url").notNull(),
	// encrypted with ORQESTRA_ENCRYPTION_KEY; never sent to the browser; null: none (a self-hosted MinerU may need none)
	apiKey: text("api_key"),
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

export type UsagePurpose = "step" | "compaction" | "title";

// One row per Model request the Provider reported usage for; outlives its Conversation and is never swept
export const usage = pgTable(
	"usage",
	{
		id: serial("id").primaryKey(),
		// the Polaris `sub` of the top-level Conversation's User (a Firing's: its Scheduled Task's)
		userId: text("user_id").notNull(),
		// the Agent that sent the request and its name then; both null for the general worker
		agentId: text("agent_id"),
		agentName: text("agent_name"),
		// the Catalog ids; the Model's name is the Catalog's, looked up when shown
		provider: text("provider").notNull(),
		modelId: text("model_id").notNull(),
		// the top-level Conversation; no foreign key, so deleting the Conversation keeps its Usage
		conversationId: uuid("conversation_id").notNull(),
		purpose: text("purpose").$type<UsagePurpose>().notNull(),
		// the Scheduled Task whose Firing started the Conversation; no foreign key either
		scheduledTaskId: uuid("scheduled_task_id"),
		inputTokens: integer("input_tokens").notNull(),
		outputTokens: integer("output_tokens").notNull(),
		cacheReadTokens: integer("cache_read_tokens").notNull(),
		cacheWriteTokens: integer("cache_write_tokens").notNull(),
		// US dollars, at the Model's price when the request was made
		cost: doublePrecision("cost").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [index().on(table.userId, table.createdAt)],
);
