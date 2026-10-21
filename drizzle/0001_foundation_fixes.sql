DROP INDEX "imports_sheet_hash_index";--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "recoveries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "imports_one_active_per_file" ON "imports" USING btree ("sheet_hash") WHERE "imports"."status" in ('queued', 'running', 'paused');