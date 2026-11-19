CREATE TABLE "integration_link_sent" (
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "integration_link_sent_kind_external_id_pk" PRIMARY KEY("kind","external_id")
);
--> statement-breakpoint
ALTER TABLE "integration_installation" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_installation" ALTER COLUMN "client_secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_installation" ALTER COLUMN "webhook_secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_installation" ADD COLUMN "credentials" text;--> statement-breakpoint
ALTER TABLE "integration_installation" ADD COLUMN "open_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_installation" ADD COLUMN "stream_state" text;