CREATE TABLE "agent" (
	"id" text PRIMARY KEY NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "search_served_by" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "scrape_served_by" text;