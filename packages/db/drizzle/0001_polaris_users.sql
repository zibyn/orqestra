-- Polaris owns the User pool: Conversations are keyed by the Polaris `sub` instead of a local user id
ALTER TABLE "conversation" DROP CONSTRAINT "conversation_user_id_user_id_fk";--> statement-breakpoint
-- A User who signed in with Polaris keeps their Conversations. Those of password-only users keep their
-- old id and stay hidden, not deleted, until mapped by hand to the person's sub at Polaris.
UPDATE "conversation" SET "user_id" = "account"."account_id" FROM "account" WHERE "account"."provider_id" = 'polaris' AND "account"."user_id" = "conversation"."user_id";--> statement-breakpoint
DROP TABLE "session";--> statement-breakpoint
DROP TABLE "account";--> statement-breakpoint
DROP TABLE "verification";--> statement-breakpoint
DROP TABLE "user";--> statement-breakpoint
DROP TABLE "instance_settings";
