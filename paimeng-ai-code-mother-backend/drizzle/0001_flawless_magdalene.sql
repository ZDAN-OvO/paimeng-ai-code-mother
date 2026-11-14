CREATE TABLE "content_blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_activities" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"app_id" integer NOT NULL,
	"type" varchar(32) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_files" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"app_id" integer NOT NULL,
	"path" text NOT NULL,
	"base_hash" varchar(64),
	"final_hash" varchar(64),
	"base_blob_id" uuid,
	"final_blob_id" uuid,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"lines_added" integer,
	"lines_deleted" integer,
	"diff_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"diff" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_plans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"app_id" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_validation_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"app_id" integer NOT NULL,
	"attempt" integer NOT NULL,
	"check_name" varchar(40) NOT NULL,
	"status" varchar(20) NOT NULL,
	"summary" text,
	"logs" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "details_status" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "details_error" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "history_used_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_blobs" ADD CONSTRAINT "content_blobs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_activities" ADD CONSTRAINT "run_activities_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_activities" ADD CONSTRAINT "run_activities_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_files" ADD CONSTRAINT "run_files_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_files" ADD CONSTRAINT "run_files_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_files" ADD CONSTRAINT "run_files_base_blob_id_content_blobs_id_fk" FOREIGN KEY ("base_blob_id") REFERENCES "public"."content_blobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_files" ADD CONSTRAINT "run_files_final_blob_id_content_blobs_id_fk" FOREIGN KEY ("final_blob_id") REFERENCES "public"."content_blobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_validation_logs" ADD CONSTRAINT "run_validation_logs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_validation_logs" ADD CONSTRAINT "run_validation_logs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_blobs_app_sha_uq" ON "content_blobs" USING btree ("app_id","sha256");--> statement-breakpoint
CREATE INDEX "content_blobs_app_idx" ON "content_blobs" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "run_activities_run_idx" ON "run_activities" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "run_activities_app_idx" ON "run_activities" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_files_run_path_uq" ON "run_files" USING btree ("run_id","path");--> statement-breakpoint
CREATE INDEX "run_files_app_idx" ON "run_files" USING btree ("app_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_plans_run_uq" ON "run_plans" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_plans_app_idx" ON "run_plans" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_validation_run_attempt_check_uq" ON "run_validation_logs" USING btree ("run_id","attempt","check_name");--> statement-breakpoint
CREATE INDEX "run_validation_run_idx" ON "run_validation_logs" USING btree ("run_id");