import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { importRows, imports, type PendingListing, products, translationState, variants } from "@/server/db/schema";
import { productPhotos } from "@/server/imports/queries";
import { LOCALES } from "@/server/translations/fields";
import { enabledLocales } from "@/server/translations/languages";

type Product = typeof products.$inferSelect;

// The reasons a product needs review, one per entry (they're stored joined with "; ")
export const splitReasons = (reason: string | null) => (reason ? reason.split("; ").filter(Boolean) : []);

// The new version waiting for an approved product, as "Use the new version" would save it: a field the merchant
// changed by hand (even after the AI wrote this version) stays theirs, the same rule as when the AI writes a listing
export function newVersionOf(product: Product): PendingListing | null {
  const pending = product.pendingListing;
  if (!pending) return null;
  const edited = new Set(product.merchantEditedFields);
  const pick = <T>(field: string, fresh: T, current: T) => (edited.has(field) ? current : fresh);
  return {
    ...pending,
    title: pick("title", pending.title, product.title),
    descriptionHtml: pick("descriptionHtml", pending.descriptionHtml, product.descriptionHtml),
    category: pick("category", pending.category, product.category),
    tags: pick("tags", pending.tags, product.tags),
    attributes: pick("attributes", pending.attributes, product.attributes),
  };
}

// The parts of a listing the review screen compares, in the order it shows them
export const LISTING_FIELDS = ["title", "descriptionHtml", "category", "tags", "attributes", "optionNames", "claims"] as const;

// JSON with object keys sorted, so the same value compares equal however it was stored
const sortedJson = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

// Which fields the new version changes. A claim counts by what it says and quotes: its source names the file, which
// is new on every upload
function changedFields(product: Product, next: PendingListing) {
  const claims = (list: PendingListing["claims"]) => list.map((c) => [c.text, c.quote]);
  return LISTING_FIELDS.filter((field) =>
    field === "claims" ? sortedJson(claims(product.claims)) !== sortedJson(claims(next.claims)) : sortedJson(product[field]) !== sortedJson(next[field]),
  );
}

// The currency a price typed in Edit is saved in: the variant's own, else the one the product's other variants use
// (if they agree on one), else the default currency of the import that last wrote the product, else EUR
export function priceCurrency(variant: { currency: string | null }, all: { currency: string | null }[], importDefault?: string | null) {
  if (variant.currency) return variant.currency;
  const used = new Set(all.flatMap((v) => (v.currency ? [v.currency] : [])));
  return used.size === 1 ? [...used][0] : (importDefault ?? "EUR");
}

// Everything the review screen shows side by side: what the AI wrote (with its confidence per field and the
// source of every claim), next to what the supplier sent (the sheet's rows, the text the listing was written
// from, the photos). Deleted products are included, so they can be looked at and restored
export async function productDetail(db: Db, productId: string) {
  const [product] = await db.select().from(products).where(eq(products.id, productId));
  if (!product) return null;

  const next = newVersionOf(product);
  const [productVariants, photos, states, enabled, lastImport, rows, nextImport] = await Promise.all([
    db.select().from(variants).where(eq(variants.productId, productId)).orderBy(asc(variants.position), asc(variants.sku)),
    productPhotos(db, [productId]),
    db.select().from(translationState).where(eq(translationState.productId, productId)),
    enabledLocales(db),
    product.lastImportId
      ? db
          .select({ id: imports.id, fileName: imports.sheetFileName, createdAt: imports.createdAt, defaultCurrency: imports.defaultCurrency })
          .from(imports)
          .where(eq(imports.id, product.lastImportId))
      : Promise.resolve([]),
    // The rows of the sheet that last wrote this product
    product.lastImportId && product.sourceRows.length
      ? db
          .select({ rowNumber: importRows.rowNumber, status: importRows.status, reason: importRows.reason, raw: importRows.raw, cleaned: importRows.cleaned })
          .from(importRows)
          .where(and(eq(importRows.importId, product.lastImportId), inArray(importRows.rowNumber, product.sourceRows)))
          .orderBy(asc(importRows.rowNumber))
      : Promise.resolve([]),
    // The upload the waiting new version came from
    next ? db.select({ id: imports.id, fileName: imports.sheetFileName }).from(imports).where(eq(imports.id, next.importId)) : Promise.resolve([]),
  ]);

  const confidenceValues = Object.values(product.confidence);
  const [imp] = lastImport;
  return {
    id: product.id,
    handle: product.handle,
    status: product.status,
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    category: product.category,
    tags: product.tags,
    attributes: product.attributes,
    // What the colour or size column really holds, when the AI renamed it ({ color: "scent" })
    optionNames: product.optionNames,
    // Each claim with the file, row and column it came from, and the supplier's exact words
    claims: product.claims,
    confidence: product.confidence,
    lowestConfidence: confidenceValues.length ? Math.min(...confidenceValues) : null,
    reviewReason: product.reviewReason,
    reviewReasons: splitReasons(product.reviewReason),
    // The problems with the listing itself (from the AI checks, or the merchant's note when sending it back)
    contentReviewReasons: product.contentReviewReasons,
    // Fields the merchant changed by hand: the AI never overwrites them
    editedFields: product.merchantEditedFields,
    model: product.model,
    promptVersion: product.promptVersion,
    approvedAt: product.approvedAt,
    deletedAt: product.deletedAt,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    lastImport: imp ? { id: imp.id, fileName: imp.fileName, createdAt: imp.createdAt } : null,
    variants: productVariants.map((v) => ({
      id: v.id,
      sku: v.sku,
      options: v.options,
      priceCents: v.priceCents,
      currency: v.currency,
      // The merchant typed this price in Edit: a re-upload of the sheet doesn't change it
      priceSetByHand: v.priceSetByHand,
      // The price the supplier's sheet last gave. Worth showing when it isn't the merchant's
      sheetPriceCents: v.sheetPriceCents,
      sheetCurrency: v.sheetCurrency,
      // The currency a price typed in Edit is saved in
      priceCurrency: priceCurrency(v, productVariants, imp?.defaultCurrency),
      weightGrams: v.weightGrams,
      position: v.position,
    })),
    photos: photos.map((p) => ({ id: p.id, fileName: p.fileName, sku: p.sku, width: p.width, height: p.height, url: p.url, thumbnailUrl: p.thumbnailUrl })),
    sourceRows: rows,
    // The supplier's text exactly as the AI saw it when it wrote this listing (row by row, column by column).
    // After a prices-only update this is still the richer file the listing came from. While a new version waits,
    // it's the text that version was written from
    writtenFrom: product.sourceInput ?? null,
    // A new listing the AI wrote for this approved product, waiting for the merchant: the shop still shows the one
    // above. With the fields it changes, its own review reasons, and the upload it came from
    newVersion: next
      ? {
          ...next,
          changes: changedFields(product, next),
          fromImport: nextImport[0] ?? null,
        }
      : null,
    translations: LOCALES.map((locale) => {
      const state = states.find((s) => s.locale === locale);
      return { locale, enabled: enabled.includes(locale), status: state?.status ?? null, error: state?.error ?? null };
    }),
  };
}

export type ProductDetail = NonNullable<Awaited<ReturnType<typeof productDetail>>>;
