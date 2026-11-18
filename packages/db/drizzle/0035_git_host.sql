ALTER TABLE "mcp_server" ADD COLUMN "git_host" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "git_username" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "token_env" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_git_host_whole" CHECK (("mcp_server"."git_host" is null) = ("mcp_server"."git_username" is null) and ("mcp_server"."git_host" is null) = ("mcp_server"."token_env" is null));