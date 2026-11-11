CREATE TABLE "model_price" (
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"input" double precision NOT NULL,
	"output" double precision NOT NULL,
	"cache_read" double precision NOT NULL,
	"cache_write" double precision NOT NULL,
	CONSTRAINT "model_price_provider_id_model_id_pk" PRIMARY KEY("provider_id","model_id"),
	CONSTRAINT "model_price_non_negative" CHECK ("model_price"."input" >= 0 and "model_price"."output" >= 0 and "model_price"."cache_read" >= 0 and "model_price"."cache_write" >= 0)
);
--> statement-breakpoint
ALTER TABLE "model_price" ADD CONSTRAINT "model_price_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade ON UPDATE no action;