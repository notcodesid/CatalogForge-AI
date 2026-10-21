CREATE TYPE "public"."ai_call_status" AS ENUM('ok', 'invalid_output', 'rate_limited', 'timeout', 'error');--> statement-breakpoint
CREATE TYPE "public"."import_stage" AS ENUM('parse', 'clean', 'group', 'photos', 'build', 'translate');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('waiting_for_files', 'queued', 'running', 'paused', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."photo_status" AS ENUM('matched', 'unmatched', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('needs_review', 'ready', 'approved');--> statement-breakpoint
CREATE TYPE "public"."row_status" AS ENUM('pending', 'processing', 'done', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."translation_author" AS ENUM('ai', 'merchant');--> statement-breakpoint
CREATE TABLE "ai_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"import_id" uuid,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" "ai_call_status" NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer NOT NULL,
	"product_count" integer DEFAULT 0 NOT NULL,
	"from_cache" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_status" (
	"provider" text PRIMARY KEY NOT NULL,
	"paused_until" timestamp with time zone,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_rows_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"cleaned" jsonb,
	"row_hash" text NOT NULL,
	"product_key" text,
	"status" "row_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "import_status" DEFAULT 'waiting_for_files' NOT NULL,
	"stage" "import_stage",
	"sheet_file_name" text NOT NULL,
	"sheet_path" text,
	"sheet_hash" text,
	"default_currency" char(3) DEFAULT 'EUR' NOT NULL,
	"parse_info" jsonb,
	"total_rows" integer,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"storage_path" text,
	"content_hash" text,
	"width" integer,
	"height" integer,
	"product_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"status" "photo_status" DEFAULT 'unmatched' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_key" text NOT NULL,
	"handle" text NOT NULL,
	"status" "product_status" DEFAULT 'needs_review' NOT NULL,
	"title" text NOT NULL,
	"description_html" text DEFAULT '' NOT NULL,
	"category" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_reason" text,
	"source_rows" integer[] DEFAULT '{}'::int[] NOT NULL,
	"last_import_id" uuid,
	"source_hash" text,
	"merchant_edited_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"model" text,
	"prompt_version" text,
	"approved_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_productKey_unique" UNIQUE("product_key"),
	CONSTRAINT "products_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"product_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"source_hash" text NOT NULL,
	"written_by" "translation_author" DEFAULT 'ai' NOT NULL,
	"out_of_date" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translations_product_id_locale_field_pk" PRIMARY KEY("product_id","locale","field")
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_cents" integer,
	"currency" char(3),
	"weight_grams" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_sku_unique" UNIQUE("sku"),
	CONSTRAINT "variants_price_not_negative" CHECK ("variants"."price_cents" >= 0),
	CONSTRAINT "variants_price_has_currency" CHECK (("variants"."price_cents" is null) = ("variants"."currency" is null)),
	CONSTRAINT "variants_weight_not_negative" CHECK ("variants"."weight_grams" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_last_import_id_imports_id_fk" FOREIGN KEY ("last_import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_import_id_index" ON "ai_calls" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "ai_calls_created_at_index" ON "ai_calls" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_import_id_row_number_index" ON "import_rows" USING btree ("import_id","row_number");--> statement-breakpoint
CREATE INDEX "import_rows_import_id_status_index" ON "import_rows" USING btree ("import_id","status");--> statement-breakpoint
CREATE INDEX "import_rows_product_key_index" ON "import_rows" USING btree ("product_key");--> statement-breakpoint
CREATE INDEX "imports_sheet_hash_index" ON "imports" USING btree ("sheet_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "photos_import_id_file_name_index" ON "photos" USING btree ("import_id","file_name");--> statement-breakpoint
CREATE INDEX "photos_product_id_index" ON "photos" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "products_status_index" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "variants_product_id_index" ON "variants" USING btree ("product_id");