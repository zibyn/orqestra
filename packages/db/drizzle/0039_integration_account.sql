CREATE TABLE "integration_account" (
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_account_kind_external_id_pk" PRIMARY KEY("kind","external_id"),
	CONSTRAINT "integration_account_kind_user_id_unique" UNIQUE("kind","user_id")
);
--> statement-breakpoint
ALTER TABLE "integration_account" ADD CONSTRAINT "integration_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;