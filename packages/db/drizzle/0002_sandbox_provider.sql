CREATE TABLE "sandbox_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"token" text NOT NULL,
	"snapshot" text,
	"cpu" double precision NOT NULL,
	"memory" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
