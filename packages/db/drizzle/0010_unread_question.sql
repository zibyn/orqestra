ALTER TABLE "conversation" ADD COLUMN "unread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "awaiting_reply" boolean DEFAULT false NOT NULL;