ALTER TYPE "public"."asset_kind" ADD VALUE 'logo';--> statement-breakpoint
ALTER TYPE "public"."asset_kind" ADD VALUE 'icon';--> statement-breakpoint
CREATE TABLE "game_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"group_id" uuid,
	"user_id" uuid,
	"can_manage_access" boolean DEFAULT false NOT NULL,
	"can_edit_info" boolean DEFAULT false NOT NULL,
	"can_manage_tests" boolean DEFAULT false NOT NULL,
	"can_view_reports" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_group_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "tagline" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "genres" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "subgenres" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "supported_platforms" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "game_modes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "engine" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "development_stage" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "age_rating" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "languages" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "trailer_url" text;--> statement-breakpoint
ALTER TABLE "game_access" ADD CONSTRAINT "game_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_access" ADD CONSTRAINT "game_access_group_id_org_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."org_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_access" ADD CONSTRAINT "game_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_access" ADD CONSTRAINT "game_access_game_org_fk" FOREIGN KEY ("game_id","organization_id") REFERENCES "public"."games"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_group_members" ADD CONSTRAINT "org_group_members_group_id_org_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."org_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_group_members" ADD CONSTRAINT "org_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_groups" ADD CONSTRAINT "org_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_access_game_idx" ON "game_access" USING btree ("game_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_access_game_group_unique" ON "game_access" USING btree ("game_id","group_id") WHERE "game_access"."group_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "game_access_game_user_unique" ON "game_access" USING btree ("game_id","user_id") WHERE "game_access"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "org_group_members_group_user_unique" ON "org_group_members" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "org_group_members_user_idx" ON "org_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "org_groups_org_idx" ON "org_groups" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_groups_org_name_unique" ON "org_groups" USING btree ("organization_id","name") WHERE "org_groups"."deleted_at" is null;