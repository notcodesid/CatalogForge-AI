import type { Locale } from "@/server/translations/fields";
import { absolute, decimalPrice, type ExportProduct, fieldsInEnglish, localized, variantOptions } from "./load";

// One row per variant, the product's fields repeated on each, in the chosen language. Meant for a spreadsheet:
// lists are joined into one readable cell
export const CSV_COLUMNS = [
  "handle",
  "title",
  "status",
  "category",
  "tags",
  "description_html",
  "attributes",
  "variant_sku",
  "variant_options",
  "price",
  "currency",
  "weight_grams",
  "image_urls",
  "claims",
  "confidence",
  "lowest_confidence",
  "review_reason",
  "source_rows",
  "seo_title",
  "seo_description",
  "fields_in_english",
] as const;

export type CsvRow = Record<(typeof CSV_COLUMNS)[number], string>;

export function toCsvRows(item: ExportProduct, language: Locale | "en", origin: string): CsvRow[] {
  const { product } = item;
  const view = localized(item, language);
  const confidence = Object.entries(product.confidence);
  const shared = {
    handle: product.handle,
    title: view.title,
    status: product.status,
    category: view.category ?? "",
    tags: view.tags.join(", "),
    description_html: view.descriptionHtml,
    attributes: view.attributes.map((a) => `${a.label}: ${a.value}`).join("; "),
    image_urls: item.photos.map((p) => absolute(origin, p.url)).join(" | "),
    claims: product.claims.map((c) => `${c.text} (${c.source})`).join("; "),
    confidence: confidence.map(([field, value]) => `${field} ${value}`).join(", "),
    lowest_confidence: confidence.length ? String(Math.min(...confidence.map(([, value]) => value))) : "",
    review_reason: product.reviewReason ?? "",
    source_rows: product.sourceRows.join(", "),
    seo_title: view.seo.metaTitle,
    seo_description: view.seo.metaDescription,
    fields_in_english: fieldsInEnglish(item, view).join(", "),
  };
  const noVariant = { variant_sku: "", variant_options: "", price: "", currency: "", weight_grams: "" };
  if (!item.variants.length) return [{ ...shared, ...noVariant }];
  return item.variants.map((v) => ({
    ...shared,
    variant_sku: v.sku,
    variant_options: variantOptions(view, v.options)
      .map((o) => `${o.label}: ${o.value}`)
      .join("; "),
    price: decimalPrice(v.priceCents),
    currency: v.currency ?? "",
    weight_grams: v.weightGrams === null ? "" : String(v.weightGrams),
  }));
}
