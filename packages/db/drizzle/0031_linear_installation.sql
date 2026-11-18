CREATE TABLE "linear_installation" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"tokens" text,
	"workspace" text,
	"default_agent_id" text,
	"team_repos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending_state" text,
	"pending_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "linear_installation_single_row" CHECK ("linear_installation"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "linear_installation" ADD CONSTRAINT "linear_installation_default_agent_id_agent_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;