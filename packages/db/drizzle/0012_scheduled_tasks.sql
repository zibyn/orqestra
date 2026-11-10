CREATE TABLE "firing" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"fired_at" timestamp DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"conversation_id" uuid
);
--> statement-breakpoint
CREATE TABLE "scheduled_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"agent_id" text NOT NULL,
	"model" text NOT NULL,
	"thinking_level" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"ends_at" timestamp with time zone,
	"time_zone" text NOT NULL,
	"incognito" boolean NOT NULL,
	"alert_on_complete" boolean DEFAULT true NOT NULL,
	"state" text NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "scheduled_task_id" uuid;--> statement-breakpoint
ALTER TABLE "firing" ADD CONSTRAINT "firing_task_id_scheduled_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firing" ADD CONSTRAINT "firing_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firing_taskId_idx" ON "firing" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "firing_conversationId_idx" ON "firing" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "scheduled_task_userId_idx" ON "scheduled_task" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_scheduled_task_id_scheduled_task_id_fk" FOREIGN KEY ("scheduled_task_id") REFERENCES "public"."scheduled_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_scheduledTaskId_idx" ON "conversation" USING btree ("scheduled_task_id");