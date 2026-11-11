CREATE TABLE "usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"agent_name" text,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"scheduled_task_id" uuid,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cost" double precision NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "usage_user_id_created_at_index" ON "usage" USING btree ("user_id","created_at");