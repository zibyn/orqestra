ALTER TABLE "inbox" ADD COLUMN "trace" jsonb;--> statement-breakpoint
ALTER TABLE "subagent" ADD COLUMN "trace" jsonb;--> statement-breakpoint
ALTER TABLE "background_call" ADD COLUMN "trace" jsonb;