CREATE TABLE "memory" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"path" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"conversation_id" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_user_id_path_unique" UNIQUE("user_id","path")
);
--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;