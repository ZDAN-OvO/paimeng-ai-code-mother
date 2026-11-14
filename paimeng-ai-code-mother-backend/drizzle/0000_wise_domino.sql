CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" integer NOT NULL,
	"conversation_id" integer NOT NULL,
	"client_request_id" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"phase" varchar(20) DEFAULT 'preparing' NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"repair_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"error_code" varchar(64),
	"error_summary" text
);
--> statement-breakpoint
CREATE TABLE "agent_session_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"entry_type" varchar(32) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"app_name" varchar(100) NOT NULL,
	"init_prompt" text NOT NULL,
	"code_gen_type" varchar(20),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"exec_blocked" boolean DEFAULT false NOT NULL,
	"delete_attempts" integer DEFAULT 0 NOT NULL,
	"delete_error" text,
	"delete_next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"run_id" uuid,
	"role" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_account" varchar(64) NOT NULL,
	"user_password" text NOT NULL,
	"user_name" varchar(64) DEFAULT '' NOT NULL,
	"user_avatar" text,
	"user_profile" text,
	"user_role" varchar(32) DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_entries" ADD CONSTRAINT "agent_session_entries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_app_client_request_uq" ON "agent_runs" USING btree ("app_id","client_request_id");--> statement-breakpoint
CREATE INDEX "runs_app_idx" ON "agent_runs" USING btree ("app_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_app_uq" ON "agent_runs" USING btree ("app_id") WHERE status in ('running','cancelling');--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "agent_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "session_entries_conversation_seq_uq" ON "agent_session_entries" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "session_entries_run_idx" ON "agent_session_entries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "apps_owner_idx" ON "apps" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "apps_status_idx" ON "apps" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_app_uq" ON "conversations" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_user_account_uq" ON "users" USING btree ("user_account");