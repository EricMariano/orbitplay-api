DROP INDEX "users_email_unique";--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "form_answers_response_idx" ON "form_answers" USING btree ("response_id");--> statement-breakpoint
CREATE INDEX "form_answers_question_idx" ON "form_answers" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "participations_user_idx" ON "participations" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_recordings_storage_key_unique" ON "session_recordings" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "sessions_participation_idx" ON "sessions" USING btree ("participation_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_org_started_idx" ON "sessions" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "community_posts_game_idx" ON "community_posts" USING btree ("game_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));