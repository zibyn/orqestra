-- The seeded General Agent named a Model that may not exist; without `models` it offers every enabled Model. Left alone if an Admin changed it.
UPDATE "agent" SET "definition" = "definition" - 'models' WHERE "id" = 'general' AND "definition"->'models' = '["deepseek/deepseek-flash"]'::jsonb;
