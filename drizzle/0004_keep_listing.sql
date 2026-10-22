ALTER TABLE "products" ADD COLUMN "source_input" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "content_review_reasons" text[] DEFAULT '{}'::text[] NOT NULL;