ALTER TABLE "game_assets" DROP CONSTRAINT "game_assets_game_id_games_id_fk";
--> statement-breakpoint
ALTER TABLE "builds" DROP CONSTRAINT "builds_test_id_tests_id_fk";
--> statement-breakpoint
ALTER TABLE "tests" DROP CONSTRAINT "tests_game_id_games_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "games_id_org_unique" ON "games" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tests_id_org_unique" ON "tests" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "game_assets" ADD CONSTRAINT "game_assets_game_org_fk" FOREIGN KEY ("game_id","organization_id") REFERENCES "public"."games"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_test_org_fk" FOREIGN KEY ("test_id","organization_id") REFERENCES "public"."tests"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_game_org_fk" FOREIGN KEY ("game_id","organization_id") REFERENCES "public"."games"("id","organization_id") ON DELETE cascade ON UPDATE no action;
