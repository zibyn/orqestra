-- Skill files move to object storage (ADR 0017): Postgres keeps each file's sha256 and size, the bytes go to skills/<name>/<sha256>.
-- Files from before keep their content and a null sha256 until the api or worker, on starting, has moved them (backfillSkillFiles);
-- a later migration drops content once none is left to move.
ALTER TABLE "skill_file" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_file" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "skill_file" ADD COLUMN "size" integer;
