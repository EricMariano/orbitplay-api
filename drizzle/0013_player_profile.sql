CREATE TYPE "public"."player_archetype" AS ENUM('achiever', 'explorer', 'socializer', 'killer');--> statement-breakpoint
ALTER TABLE "player_preferences" ADD COLUMN "archetype" "player_archetype";--> statement-breakpoint
ALTER TABLE "player_preferences" ADD COLUMN "player_tier" "player_tier";