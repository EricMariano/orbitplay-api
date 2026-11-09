ALTER TABLE "builds" ADD COLUMN "scan_engine" text;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "scan_signatures" text;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "scan_finished_at" timestamp with time zone;