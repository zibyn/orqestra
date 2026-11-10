CREATE TABLE "document_parser" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"url" text NOT NULL,
	"api_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
