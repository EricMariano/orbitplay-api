CREATE TYPE "public"."report_export_format" AS ENUM('csv', 'pdf');--> statement-breakpoint
CREATE TABLE "test_report_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"test_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"format" "report_export_format" NOT NULL,
	"status" "processing_status" DEFAULT 'processing' NOT NULL,
	"storage_key" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "test_report_exports" ADD CONSTRAINT "test_report_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_report_exports" ADD CONSTRAINT "test_report_exports_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_report_exports" ADD CONSTRAINT "test_report_exports_test_org_fk" FOREIGN KEY ("test_id","organization_id") REFERENCES "public"."tests"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_report_exports_test_idx" ON "test_report_exports" USING btree ("test_id");