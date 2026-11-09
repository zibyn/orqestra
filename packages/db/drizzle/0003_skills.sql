CREATE TABLE "skill" (
	"name" text PRIMARY KEY NOT NULL,
	"current_version_id" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_file" (
	"version_id" integer NOT NULL,
	"path" text NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "skill_file_version_id_path_pk" PRIMARY KEY("version_id","path")
);
--> statement-breakpoint
CREATE TABLE "skill_version" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_name" text NOT NULL,
	"number" integer NOT NULL,
	"description" text NOT NULL,
	"disable_model_invocation" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_version_skill_name_number_unique" UNIQUE("skill_name","number")
);
--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_current_version_id_skill_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."skill_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_file" ADD CONSTRAINT "skill_file_version_id_skill_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."skill_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version" ADD CONSTRAINT "skill_version_skill_name_skill_name_fk" FOREIGN KEY ("skill_name") REFERENCES "public"."skill"("name") ON DELETE cascade ON UPDATE no action;