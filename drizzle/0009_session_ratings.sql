CREATE TABLE "session_ratings" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"rated_by_user_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"marked_invalid" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_ratings_rating_range" CHECK ("session_ratings"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "session_ratings" ADD CONSTRAINT "session_ratings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_ratings" ADD CONSTRAINT "session_ratings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_ratings" ADD CONSTRAINT "session_ratings_rated_by_user_id_users_id_fk" FOREIGN KEY ("rated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_ratings_org_idx" ON "session_ratings" USING btree ("organization_id");