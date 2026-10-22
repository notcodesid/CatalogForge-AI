CREATE TYPE "public"."translation_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "country_languages" (
	"country" char(2) PRIMARY KEY NOT NULL,
	"language" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translation_state" (
	"product_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"status" "translation_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"queued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_state_product_id_locale_pk" PRIMARY KEY("product_id","locale")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "english_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "translation_state" ADD CONSTRAINT "translation_state_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "translation_state_status_index" ON "translation_state" USING btree ("status");--> statement-breakpoint
ALTER TABLE "translations" DROP COLUMN "out_of_date";--> statement-breakpoint
-- Which language each country sees. Germany, Austria and France are on; the others can be switched on later
INSERT INTO "country_languages" ("country", "language", "enabled") VALUES ('DE', 'de', true), ('AT', 'de', true), ('CH', 'de', false), ('LI', 'de', false), ('FR', 'fr', true), ('BE', 'fr', false), ('LU', 'fr', false), ('MC', 'fr', false) ON CONFLICT DO NOTHING;
