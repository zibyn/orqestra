CREATE TABLE "subagent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"number" integer NOT NULL,
	"template" text,
	"brief" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subagent" ADD CONSTRAINT "subagent_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subagent_conversationId_idx" ON "subagent" USING btree ("conversation_id");