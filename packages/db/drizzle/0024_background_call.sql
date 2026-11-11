CREATE TABLE "background_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"mcp_server_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"reference" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"job_id" text NOT NULL,
	"message_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"polled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "background_call_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "background_call_id" uuid;--> statement-breakpoint
ALTER TABLE "background_call" ADD CONSTRAINT "background_call_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_call" ADD CONSTRAINT "background_call_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "background_call_conversationId_idx" ON "background_call" USING btree ("conversation_id");