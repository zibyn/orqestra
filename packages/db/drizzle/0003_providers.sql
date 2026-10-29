CREATE TABLE "enabled_model" (
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	CONSTRAINT "enabled_model_provider_id_model_id_pk" PRIMARY KEY("provider_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "provider" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key" text NOT NULL,
	"base_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enabled_model" ADD CONSTRAINT "enabled_model_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade ON UPDATE no action;