ALTER TABLE "conversation" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "subagents_since_user" integer DEFAULT 0 NOT NULL;