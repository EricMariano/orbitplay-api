CREATE TYPE "public"."asset_kind" AS ENUM('cover', 'banner', 'screenshot');--> statement-breakpoint
CREATE TYPE "public"."build_status" AS ENUM('awaiting_upload', 'uploading', 'processing', 'validated', 'failed');--> statement-breakpoint
CREATE TYPE "public"."build_step_key" AS ENUM('checksum', 'malware_scan', 'metadata', 'plugin_manifest');--> statement-breakpoint
CREATE TYPE "public"."participation_status" AS ENUM('reserved', 'tutorial', 'downloading', 'ready', 'playing', 'form_pending', 'in_review', 'completed', 'rejected', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('visible', 'hidden', 'removed');--> statement-breakpoint
CREATE TYPE "public"."processing_status" AS ENUM('processing', 'ready', 'failed', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('scale', 'single_choice', 'multiple_choice', 'open_text', 'boolean', 'nps');--> statement-breakpoint
CREATE TYPE "public"."recording_kind" AS ENUM('screen', 'webcam', 'microphone');--> statement-breakpoint
CREATE TYPE "public"."report_stage" AS ENUM('none', 'partial', 'final');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('starting', 'recording', 'paused', 'finishing', 'processing', 'completed', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."test_model_key" AS ENUM('free_exploration_telemetry', 'free_exploration', 'ab_test', 'ab_test_images');--> statement-breakpoint
CREATE TYPE "public"."test_status" AS ENUM('draft', 'published', 'paused', 'finished', 'expired');--> statement-breakpoint
CREATE TYPE "public"."wizard_step" AS ENUM('model', 'form', 'build', 'audience', 'review');--> statement-breakpoint
CREATE TABLE "build_validation_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"build_id" uuid NOT NULL,
	"key" "build_step_key" NOT NULL,
	"status" "processing_status" DEFAULT 'processing' NOT NULL,
	"message" text,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"test_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"version" text,
	"platform" text,
	"size_bytes" bigint,
	"checksum" text,
	"storage_key" text NOT NULL,
	"status" "build_status" DEFAULT 'awaiting_upload' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_audience_criteria" (
	"test_id" uuid PRIMARY KEY NOT NULL,
	"countries" text[],
	"archetypes" text[],
	"platforms" text[],
	"age_min" integer,
	"age_max" integer,
	"tester_count" integer,
	"keep_active" boolean DEFAULT true NOT NULL,
	"estimated_reach" integer
);
--> statement-breakpoint
CREATE TABLE "test_form_options" (
	"id" uuid PRIMARY KEY NOT NULL,
	"question_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_form_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"test_id" uuid NOT NULL,
	"type" "question_type" NOT NULL,
	"label" text NOT NULL,
	"help_text" text,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"scale_min" integer,
	"scale_max" integer
);
--> statement-breakpoint
CREATE TABLE "tests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"name" text,
	"model_key" "test_model_key" NOT NULL,
	"status" "test_status" DEFAULT 'draft' NOT NULL,
	"current_step" "wizard_step" DEFAULT 'model' NOT NULL,
	"slots_total" integer DEFAULT 0 NOT NULL,
	"slots_taken" integer DEFAULT 0 NOT NULL,
	"duration_days" integer,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"publish_idempotency_key" text,
	"reward_amount_cents" integer,
	"reward_currency" text,
	"report_stage" "report_stage" DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_answers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"response_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"value_text" text,
	"value_number" numeric,
	"value_boolean" boolean,
	"option_ids" uuid[]
);
--> statement-breakpoint
CREATE TABLE "form_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"idempotency_key" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"test_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "participation_status" DEFAULT 'reserved' NOT NULL,
	"resume_point" text,
	"idempotency_key" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_consents" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"screen_recording" boolean DEFAULT false NOT NULL,
	"audio" boolean DEFAULT false NOT NULL,
	"microphone" boolean DEFAULT false NOT NULL,
	"webcam" boolean DEFAULT false NOT NULL,
	"accepted_at" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "session_device_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"t_ms" integer NOT NULL,
	"kind" text NOT NULL,
	"value" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_recordings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" "recording_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint,
	"duration_ms" integer,
	"status" "processing_status" DEFAULT 'processing' NOT NULL,
	"thumbnail_key" text
);
--> statement-breakpoint
CREATE TABLE "session_validations" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"valid" boolean,
	"reason" text,
	"validator_version" text,
	"validated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"participation_id" uuid NOT NULL,
	"test_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" "session_status" DEFAULT 'starting' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"finish_idempotency_key" text
);
--> statement-breakpoint
CREATE TABLE "achievements" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon_key" text,
	"rule" jsonb
);
--> statement-breakpoint
CREATE TABLE "feed_ranking_snapshots" (
	"seed" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"filters_hash" text,
	"item_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"reward_xp" integer,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "player_achievements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"achievement_key" text NOT NULL,
	"progress" numeric DEFAULT '0' NOT NULL,
	"unlocked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "player_missions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"mission_key" text NOT NULL,
	"progress" numeric DEFAULT '0' NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "player_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"genres" text[],
	"platforms" text[],
	"device_profile" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ranking_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"period" text NOT NULL,
	"game_id" uuid,
	"entries" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xp_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"xp" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"status" "post_status" DEFAULT 'visible' NOT NULL,
	"moderated_by" uuid,
	"moderated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" numeric NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"endpoint" text NOT NULL,
	"request_hash" text,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_report_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"test_id" uuid NOT NULL,
	"block_key" text NOT NULL,
	"status" "processing_status" DEFAULT 'processing' NOT NULL,
	"payload" jsonb,
	"computed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "game_assets" ALTER COLUMN "kind" SET DATA TYPE "public"."asset_kind" USING "kind"::"public"."asset_kind";--> statement-breakpoint
ALTER TABLE "build_validation_steps" ADD CONSTRAINT "build_validation_steps_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_audience_criteria" ADD CONSTRAINT "test_audience_criteria_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_form_options" ADD CONSTRAINT "test_form_options_question_id_test_form_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."test_form_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_form_questions" ADD CONSTRAINT "test_form_questions_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_answers" ADD CONSTRAINT "form_answers_response_id_form_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."form_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_answers" ADD CONSTRAINT "form_answers_question_id_test_form_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."test_form_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participations" ADD CONSTRAINT "participations_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participations" ADD CONSTRAINT "participations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_consents" ADD CONSTRAINT "session_consents_participation_id_participations_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."participations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_device_events" ADD CONSTRAINT "session_device_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_recordings" ADD CONSTRAINT "session_recordings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_validations" ADD CONSTRAINT "session_validations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_participation_id_participations_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."participations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_ranking_snapshots" ADD CONSTRAINT "feed_ranking_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_achievements" ADD CONSTRAINT "player_achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_achievements" ADD CONSTRAINT "player_achievements_achievement_key_achievements_key_fk" FOREIGN KEY ("achievement_key") REFERENCES "public"."achievements"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_missions" ADD CONSTRAINT "player_missions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_missions" ADD CONSTRAINT "player_missions_mission_key_missions_key_fk" FOREIGN KEY ("mission_key") REFERENCES "public"."missions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_preferences" ADD CONSTRAINT "player_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_snapshots" ADD CONSTRAINT "ranking_snapshots_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_moderated_by_users_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_reviews" ADD CONSTRAINT "game_reviews_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_reviews" ADD CONSTRAINT "game_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_report_snapshots" ADD CONSTRAINT "test_report_snapshots_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "build_validation_steps_unique" ON "build_validation_steps" USING btree ("build_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "test_form_options_order_unique" ON "test_form_options" USING btree ("question_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "test_form_questions_order_unique" ON "test_form_questions" USING btree ("test_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "tests_publish_idempotency_key_unique" ON "tests" USING btree ("publish_idempotency_key");--> statement-breakpoint
CREATE INDEX "tests_org_idx" ON "tests" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tests_game_status_idx" ON "tests" USING btree ("game_id","status");--> statement-breakpoint
CREATE INDEX "tests_feed_idx" ON "tests" USING btree ("status","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_responses_session_unique" ON "form_responses" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "participations_test_user_idx" ON "participations" USING btree ("test_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participations_active_test_user_unique" ON "participations" USING btree ("test_id","user_id") WHERE "participations"."status" IN ('reserved', 'tutorial', 'downloading', 'ready', 'playing', 'form_pending', 'in_review');--> statement-breakpoint
CREATE INDEX "session_device_events_idx" ON "session_device_events" USING btree ("session_id","t_ms");--> statement-breakpoint
CREATE INDEX "sessions_test_idx" ON "sessions" USING btree ("test_id");--> statement-breakpoint
CREATE UNIQUE INDEX "player_achievements_unique" ON "player_achievements" USING btree ("user_id","achievement_key");--> statement-breakpoint
CREATE UNIQUE INDEX "player_missions_unique" ON "player_missions" USING btree ("user_id","mission_key");--> statement-breakpoint
CREATE UNIQUE INDEX "xp_events_source_unique" ON "xp_events" USING btree ("user_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_reviews_unique" ON "game_reviews" USING btree ("game_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_report_snapshots_unique" ON "test_report_snapshots" USING btree ("test_id","block_key");--> statement-breakpoint
ALTER TABLE "heatmap_cells" ADD CONSTRAINT "heatmap_cells_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_manifests" ADD CONSTRAINT "plugin_manifests_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tokens" ADD CONSTRAINT "session_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;