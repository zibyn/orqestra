ALTER TABLE "conversation" ADD COLUMN "root_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Subagents did not nest before: a Subagent's parent is its root
UPDATE "conversation" SET "root_id" = coalesce("parent_id", "id"), "depth" = CASE WHEN "parent_id" IS NULL THEN 0 ELSE 1 END;--> statement-breakpoint
ALTER TABLE "conversation" ALTER COLUMN "root_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_root_id_conversation_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_rootId_idx" ON "conversation" USING btree ("root_id");--> statement-breakpoint
-- a Conversation's place in its tree follows from its parent, so every insert gets it right without saying it
CREATE FUNCTION conversation_tree() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.parent_id IS NULL THEN
		NEW.root_id := NEW.id;
		NEW.depth := 0;
	ELSE
		SELECT root_id, depth + 1 INTO NEW.root_id, NEW.depth FROM conversation WHERE id = NEW.parent_id;
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER conversation_tree BEFORE INSERT ON "conversation" FOR EACH ROW EXECUTE FUNCTION conversation_tree();
