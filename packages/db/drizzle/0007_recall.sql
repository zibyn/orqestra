CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- a pi user or assistant message's text parts, without thinking or Tool calls; null for any other message
CREATE FUNCTION message_text(m jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
	SELECT CASE WHEN m->>'role' IN ('user', 'assistant') THEN
		CASE WHEN jsonb_typeof(m->'content') = 'string' THEN m->>'content'
		ELSE (SELECT string_agg(p->>'text', E'\n') FROM jsonb_array_elements(m->'content') p WHERE p->>'type' = 'text')
		END
	END
$$;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "text" text GENERATED ALWAYS AS (message_text(message)) STORED;--> statement-breakpoint
CREATE INDEX "message_text_trgm_idx" ON "message" USING gin ("text" gin_trgm_ops);
