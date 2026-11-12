CREATE TABLE "memory_change" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"user_id" text NOT NULL,
	"path" text NOT NULL,
	"before" jsonb,
	"before_conversation_id" uuid,
	"after" jsonb,
	"undone" boolean DEFAULT false NOT NULL,
	CONSTRAINT "memory_change_conversation_id_tool_call_id_unique" UNIQUE("conversation_id","tool_call_id")
);
--> statement-breakpoint
ALTER TABLE "memory_change" ADD CONSTRAINT "memory_change_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_change" ADD CONSTRAINT "memory_change_before_conversation_id_conversation_id_fk" FOREIGN KEY ("before_conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill from the Memory Tool results not yet undone (ADR 0011): what each call left is memory_write's `after`, memory_edit's `before` with `old`
-- (which occurred once) replaced, and nothing for memory_delete
INSERT INTO "memory_change" ("conversation_id", "tool_call_id", "user_id", "path", "before", "before_conversation_id", "after")
SELECT "m"."conversation_id", "m"."message"->>'toolCallId', "c"."user_id", "d"->>'path',
	CASE WHEN "b" IS NULL THEN NULL ELSE jsonb_build_object('description', "b"->>'description', 'body', "b"->>'body') END,
	(SELECT "id" FROM "conversation" WHERE "id"::text = "b"->>'conversationId'),
	CASE "m"."message"->>'toolName'
		WHEN 'memory_write' THEN jsonb_build_object('description', "d"#>>'{after,description}', 'body', "d"#>>'{after,body}')
		WHEN 'memory_edit' THEN jsonb_build_object('description', "b"->>'description', 'body', replace("b"->>'body', "d"->>'old', "d"->>'new'))
	END
FROM "message" "m"
	JOIN "conversation" "c" ON "c"."id" = "m"."conversation_id",
	LATERAL (SELECT "m"."message"->'details' AS "d") "x",
	LATERAL (SELECT nullif("d"->'before', 'null'::jsonb) AS "b") "y"
WHERE "m"."message"->>'role' = 'toolResult'
	AND "m"."message"->>'toolName' IN ('memory_write', 'memory_edit', 'memory_delete')
	AND "m"."message"->>'isError' = 'false'
	AND "d"->>'path' IS NOT NULL
	AND NOT coalesce(("d"->>'undone')::boolean, false)
	-- an edit or a delete always had a Memory before
	AND ("b" IS NOT NULL OR "m"."message"->>'toolName' = 'memory_write')
ON CONFLICT DO NOTHING;