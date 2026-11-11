ALTER TABLE "conversation" ADD COLUMN "failure" text;--> statement-breakpoint
ALTER TABLE "limits" ADD COLUMN "spending_limit" jsonb DEFAULT '{"mode":"unlimited"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "limits" ADD COLUMN "reset_time_zone" text DEFAULT 'UTC' NOT NULL;