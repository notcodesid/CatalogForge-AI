ALTER TYPE "public"."photo_status" ADD VALUE 'pending' BEFORE 'matched';--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "missing_photos" jsonb;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "original_path" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "thumbnail_path" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "product_key" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "sku" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "variant_id" uuid;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "row_number" integer;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photos_import_id_status_index" ON "photos" USING btree ("import_id","status");