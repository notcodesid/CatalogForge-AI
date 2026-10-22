ALTER TABLE "products" ADD COLUMN "pending_listing" jsonb;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "sheet_price_cents" integer;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "sheet_currency" char(3);--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_sheet_price_has_currency" CHECK (("variants"."sheet_price_cents" is null) = ("variants"."sheet_currency" is null));--> statement-breakpoint
-- A price that came from the sheet is the sheet's last price. For one the merchant typed, it isn't known yet
UPDATE "variants" SET "sheet_price_cents" = "price_cents", "sheet_currency" = "currency" WHERE NOT "price_set_by_hand";
