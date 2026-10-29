-- Subagents become child Conversations; every input goes through the inbox (docs/design/subagent-sessions.md §3)
ALTER TABLE "conversation" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_parent_id_conversation_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "subagent_id" uuid;--> statement-breakpoint
CREATE TABLE "inbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message" jsonb NOT NULL,
	"model" text NOT NULL,
	"thinking_level" text NOT NULL,
	"subagent_id" uuid,
	"wake" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_conversationId_idx" ON "inbox" USING btree ("conversation_id");--> statement-breakpoint
-- each existing Subagent gets its own Conversation, keyed by its old row id, holding its transcript
INSERT INTO "conversation" ("id", "user_id", "parent_id", "agent_id", "title_edited", "status", "created_at", "updated_at")
SELECT s."id", c."user_id", s."conversation_id", s."template", false, 'idle', s."created_at", s."created_at"
FROM "subagent" s JOIN "conversation" c ON c."id" = s."conversation_id";--> statement-breakpoint
INSERT INTO "message" ("conversation_id", "message", "model", "thinking_level", "created_at")
SELECT s."id", m."value",
	-- user messages carry no Model: take the one the Subagent replied with, else its parent's
	coalesce(
		(m."value"->>'provider') || '/' || (m."value"->>'model'),
		(SELECT (r."value"->>'provider') || '/' || (r."value"->>'model') FROM jsonb_array_elements(s."messages") r WHERE r."value"->>'role' = 'assistant' LIMIT 1),
		(SELECT pm."model" FROM "message" pm WHERE pm."conversation_id" = s."conversation_id" ORDER BY pm."id" DESC LIMIT 1),
		'unknown'
	),
	'off', s."created_at"
FROM "subagent" s CROSS JOIN LATERAL jsonb_array_elements(s."messages") WITH ORDINALITY AS m("value", "ord")
ORDER BY s."created_at", s."id", m."ord";--> statement-breakpoint
ALTER TABLE "subagent" DROP CONSTRAINT "subagent_conversation_id_conversation_id_fk";--> statement-breakpoint
DROP INDEX "subagent_conversationId_idx";--> statement-breakpoint
ALTER TABLE "subagent" DROP COLUMN "messages";--> statement-breakpoint
ALTER TABLE "subagent" RENAME COLUMN "conversation_id" TO "parent_id";--> statement-breakpoint
ALTER TABLE "subagent" RENAME COLUMN "id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "subagent" ALTER COLUMN "conversation_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "subagent" RENAME COLUMN "status" TO "outcome";--> statement-breakpoint
-- numbers restarted with every Run; they are now unique within the parent
UPDATE "subagent" s SET "number" = n."number"
FROM (SELECT "conversation_id", row_number() OVER (PARTITION BY "parent_id" ORDER BY "created_at", "number") AS "number" FROM "subagent") n
WHERE n."conversation_id" = s."conversation_id";--> statement-breakpoint
ALTER TABLE "subagent" ADD CONSTRAINT "subagent_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subagent" ADD CONSTRAINT "subagent_parent_id_conversation_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subagent" ADD CONSTRAINT "subagent_parent_id_number_unique" UNIQUE("parent_id","number");
