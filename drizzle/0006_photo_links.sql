ALTER TABLE "imports" ADD COLUMN "photo_links_over_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "assigned_by_hand" boolean DEFAULT false NOT NULL;