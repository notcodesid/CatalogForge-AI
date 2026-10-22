import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { importRows, products, translations, variants } from "@/server/db/schema";
import { productPhotos } from "@/server/imports/queries";
import { englishFields, type Locale, TRANSLATED_FIELDS } from "@/server/translations/fields";
import { localizeProduct, type TranslationRow } from "@/server/translations/localize";

// Which products go into an export. Deleted products never do
export type ExportStatus = "approved" | "ready" | "all";

export type ExportProduct = {
  product: typeof products.$inferSelect;
  variants: (typeof variants.$inferSelect)[];
  photos: Awaited<ReturnType<typeof productPhotos>>;
  translations: (TranslationRow & { locale: string })[];
  // The supplier's brand, from the rows the product was built from (Shopify's "Vendor")
  vendor: string | null;
};

// One page of products, in handle order. Handles are unique, so "after this handle" walks the whole catalog
// without skipping or repeating a product, even while an import is changing other products
export async function loadPage(db: Db, options: { status: ExportStatus; afterHandle: string | null; limit: number }): Promise<ExportProduct[]> {
  const page = await db
    .select({
      product: products,
      vendor: sql<string | null>`(
        select ${importRows.cleaned}->>'brand' from ${importRows}
        where ${importRows.importId} = ${products.lastImportId} and ${importRows.rowNumber} = any(${products.sourceRows})
          and coalesce(${importRows.cleaned}->>'brand', '') <> ''
        order by ${importRows.rowNumber} limit 1
      )`,
    })
    .from(products)
    .where(
      and(
        isNull(products.deletedAt),
        options.status === "all" ? undefined : eq(products.status, options.status),
        options.afterHandle === null ? undefined : gt(products.handle, options.afterHandle),
      ),
    )
    .orderBy(asc(products.handle))
    .limit(options.limit);
  if (!page.length) return [];

  const ids = page.map((p) => p.product.id);
  const [allVariants, allPhotos, allTranslations] = await Promise.all([
    db.select().from(variants).where(inArray(variants.productId, ids)).orderBy(asc(variants.position), asc(variants.sku)),
    productPhotos(db, ids),
    db
      .select({
        productId: translations.productId,
        locale: translations.locale,
        field: translations.field,
        value: translations.value,
        sourceHash: translations.sourceHash,
        writtenBy: translations.writtenBy,
        issue: translations.issue,
      })
      .from(translations)
      .where(inArray(translations.productId, ids)),
  ]);

  return page.map(({ product, vendor }) => ({
    product,
    vendor,
    variants: allVariants.filter((v) => v.productId === product.id),
    photos: allPhotos.filter((p) => p.productId === product.id),
    translations: allTranslations.filter((t) => t.productId === product.id),
  }));
}

// The product as a shopper in that language sees it: the merchant's own translation, else the AI's (made from
// the current English and passed every check), else the English. Never an AI call
export function localized(item: ExportProduct, language: Locale | "en") {
  return localizeProduct(
    item.product,
    item.variants,
    item.translations.filter((t) => t.locale === language),
    language,
  );
}

export type Localized = ReturnType<typeof localized>;

// Fields a shopper in that language still reads in English: no translation yet, or the AI's failed a check
export function fieldsInEnglish(item: ExportProduct, view: Localized) {
  if (view.locale === "en") return [];
  const present = englishFields(item.product, item.variants);
  return TRANSLATED_FIELDS.filter((field) => field in present && view.sources[field] === "english");
}

// A variant's options in that language: { size: "20 cm", color: "Terrakotta" }, keyed by the option's name,
// with its label for display
export function variantOptions(view: Localized, options: Record<string, string>) {
  return Object.entries(options).map(([name, value]) => {
    const option = view.options.find((o) => o.name === name);
    return { name, label: option?.label ?? name, value: option?.values[value] ?? value };
  });
}

export const decimalPrice = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

// Photo links are absolute in an export: the file is read outside the app
export const absolute = (origin: string, path: string) => `${origin.replace(/\/+$/, "")}${path}`;
