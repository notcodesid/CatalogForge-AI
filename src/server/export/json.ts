import type { Locale } from "@/server/translations/fields";
import { absolute, type ExportProduct, fieldsInEnglish, localized, variantOptions } from "./load";

function translation(item: ExportProduct, locale: Locale) {
  const view = localized(item, locale);
  return {
    title: view.title,
    description_html: view.descriptionHtml,
    category: view.category,
    tags: view.tags,
    attributes: Object.fromEntries(view.attributes.map((a) => [a.key, { label: a.label, value: a.value }])),
    options: Object.fromEntries(view.options.map((o) => [o.name, { label: o.label, values: o.values }])),
    seo: { meta_title: view.seo.metaTitle, meta_description: view.seo.metaDescription },
    fields_in_english: fieldsInEnglish(item, view),
    // The merchant's own translations whose English changed since
    out_of_date: view.outOfDate,
  };
}

// The brief's product format, in the chosen language, plus the photos and the product in every shop language
export function toJsonProduct(item: ExportProduct, language: Locale | "en", shopLocales: Locale[], origin: string) {
  const { product } = item;
  const view = localized(item, language);
  return {
    title: view.title,
    handle: product.handle,
    description_html: view.descriptionHtml,
    category: view.category,
    tags: view.tags,
    attributes: Object.fromEntries(view.attributes.map((a) => [a.key, a.value])),
    variants: item.variants.map((v) => ({
      sku: v.sku,
      options: Object.fromEntries(variantOptions(view, v.options).map((o) => [o.name, o.value])),
      price_cents: v.priceCents,
      currency: v.currency,
      weight_grams: v.weightGrams,
    })),
    claims: product.claims.map((c) => ({ text: c.text, source: c.source })),
    confidence: product.confidence,
    status: product.status,
    review_reason: product.reviewReason,
    source_rows: product.sourceRows,
    photos: item.photos.map((p) => ({
      url: absolute(origin, p.url),
      thumbnail_url: absolute(origin, p.thumbnailUrl),
      sku: p.sku,
      width: p.width,
      height: p.height,
    })),
    translations: Object.fromEntries(shopLocales.map((locale) => [locale, translation(item, locale)])),
  };
}
