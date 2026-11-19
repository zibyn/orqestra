ALTER TABLE "integration_installation" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_installation" ALTER COLUMN "client_secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_installation" ALTER COLUMN "webhook_secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_installation" ADD COLUMN "credentials" text;--> statement-breakpoint
ALTER TABLE "integration_installation" ADD COLUMN "open_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;