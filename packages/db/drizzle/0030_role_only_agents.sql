ALTER TABLE "enabled_model" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "limits" ADD COLUMN "compaction_reserve_tokens" integer DEFAULT 16384 NOT NULL;--> statement-breakpoint
ALTER TABLE "limits" ADD COLUMN "compaction_keep_recent_tokens" integer DEFAULT 20000 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "enabled_model_one_default" ON "enabled_model" USING btree ("is_default") WHERE "enabled_model"."is_default";--> statement-breakpoint
-- An Agent Definition only says who the Agent is (ADR 0012): Models, thinking and memory are the User's, compaction is in the Limits
UPDATE "agent" SET "definition" = "definition" - 'models' - 'defaultModel' - 'thinking' - 'memory' - 'compaction';
