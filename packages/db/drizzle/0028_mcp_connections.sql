CREATE TABLE "mcp_connection" (
	"user_id" text NOT NULL,
	"mcp_server_id" text NOT NULL,
	"tokens" text NOT NULL,
	"issuer" text NOT NULL,
	"scope" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connection_user_id_mcp_server_id_pk" PRIMARY KEY("user_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_pending_authorization" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"mcp_server_id" text NOT NULL,
	"issuer" text NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_registered_client" (
	"mcp_server_id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"client" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_connection" ADD CONSTRAINT "mcp_connection_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_pending_authorization" ADD CONSTRAINT "mcp_pending_authorization_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_registered_client" ADD CONSTRAINT "mcp_registered_client_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_pending_authorization_user_id_mcp_server_id_index" ON "mcp_pending_authorization" USING btree ("user_id","mcp_server_id");