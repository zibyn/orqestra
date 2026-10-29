ALTER TABLE "instance_settings" ADD COLUMN "setup_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Instances that already have an Admin finished Instance Setup before this column existed
INSERT INTO "instance_settings" ("id", "setup_completed") SELECT 1, true WHERE EXISTS (SELECT 1 FROM "user" WHERE "role" = 'admin') ON CONFLICT ("id") DO UPDATE SET "setup_completed" = true;
