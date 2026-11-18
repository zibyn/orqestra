CREATE TABLE "linear_session" (
	"agent_session_id" text PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	CONSTRAINT "linear_session_conversation_id_unique" UNIQUE("conversation_id")
);
--> statement-breakpoint
ALTER TABLE "linear_session" ADD CONSTRAINT "linear_session_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;