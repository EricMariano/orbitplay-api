CREATE TYPE "public"."player_tier" AS ENUM('all', 'casual', 'experienced', 'trained', 'qa');--> statement-breakpoint
ALTER TABLE "test_audience_criteria" ADD COLUMN "player_tier" "player_tier" DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_audience_criteria" ADD COLUMN "boosted" boolean DEFAULT false NOT NULL;