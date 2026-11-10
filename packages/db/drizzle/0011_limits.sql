CREATE TABLE "limits" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"max_scheduled_tasks_per_user" integer NOT NULL,
	"min_firing_interval" integer NOT NULL,
	"timer_rings_per_user_message" integer NOT NULL,
	"unattended_max_steps" integer NOT NULL,
	"unattended_max_duration" integer NOT NULL,
	"max_subagent_depth" integer NOT NULL,
	CONSTRAINT "limits_single_row" CHECK ("limits"."id" = 1),
	CONSTRAINT "limits_max_subagent_depth" CHECK ("limits"."max_subagent_depth" between 1 and 3)
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "unattended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "origin" text;