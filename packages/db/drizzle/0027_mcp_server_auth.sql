ALTER TABLE "mcp_server" ADD COLUMN "auth" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "oauth_client_secret" text;