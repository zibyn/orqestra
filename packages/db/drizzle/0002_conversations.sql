CREATE TABLE "compaction" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"first_kept_message_id" integer NOT NULL,
	"tokens_before" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text,
	"title_edited" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message" jsonb NOT NULL,
	"model" text NOT NULL,
	"thinking_level" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compaction" ADD CONSTRAINT "compaction_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compaction" ADD CONSTRAINT "compaction_first_kept_message_id_message_id_fk" FOREIGN KEY ("first_kept_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compaction_conversationId_idx" ON "compaction" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_userId_idx" ON "conversation" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_conversationId_idx" ON "message" USING btree ("conversation_id");