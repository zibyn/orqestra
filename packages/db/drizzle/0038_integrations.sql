CREATE TABLE "integration_installation" (
	"kind" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"tokens" text,
	"workspace" text,
	"needs_reinstall" boolean DEFAULT false NOT NULL,
	"default_agent_id" text,
	"team_repos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending_state" text,
	"pending_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_session" (
	"kind" text NOT NULL,
	"session_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"closed_job_id" text,
	CONSTRAINT "integration_session_kind_session_id_pk" PRIMARY KEY("kind","session_id"),
	CONSTRAINT "integration_session_conversation_id_unique" UNIQUE("conversation_id")
);
--> statement-breakpoint
ALTER TABLE "integration_installation" ADD CONSTRAINT "integration_installation_default_agent_id_agent_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_session" ADD CONSTRAINT "integration_session_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "integration_installation" ("kind", "client_id", "client_secret", "webhook_secret", "tokens", "workspace", "needs_reinstall", "default_agent_id", "team_repos", "pending_state", "pending_at", "created_at", "updated_at") SELECT 'linear', "client_id", "client_secret", "webhook_secret", "tokens", "workspace", "needs_reinstall", "default_agent_id", "team_repos", "pending_state", "pending_at", "created_at", "updated_at" FROM "linear_installation";--> statement-breakpoint
INSERT INTO "integration_session" ("kind", "session_id", "conversation_id", "closed_job_id") SELECT 'linear', "agent_session_id", "conversation_id", "closed_job_id" FROM "linear_session";--> statement-breakpoint
DROP TABLE "linear_installation" CASCADE;--> statement-breakpoint
DROP TABLE "linear_session" CASCADE;