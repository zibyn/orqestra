CREATE TABLE "timer" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"note" text NOT NULL,
	"rings_at" timestamp with time zone NOT NULL,
	"message_id" integer NOT NULL,
	"model" text NOT NULL,
	"thinking_level" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "timer_rings_since_user" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "timer" ADD CONSTRAINT "timer_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timer" ADD CONSTRAINT "timer_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;