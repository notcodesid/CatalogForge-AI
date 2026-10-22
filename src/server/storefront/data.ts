import { and, asc, count, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { imports, photos, products, translations, variants } from "@/server/db/schema";
import { translateCategory } from "@/server/translations/categories";
import { listCountries } from "@/server/translations/languages";
import { localizeProduct, type TranslationRow } from "@/server/translations/localize";
import type { Language, ShopCountry } from "./country";

// What the storefront reads, straight from the database. Never the AI: everything shoppers see was written and
// translated ahead of time. Only approved products that aren't deleted are shown. These are plain functions so
// they can be tested; pages use the cached versions in cached.ts

export const PAGE_SIZE = 24;

const onSale = and(eq(products.status, "approved"), isNull(products.deletedAt));

// The lowest price; varies = the variants don't all cost the same (shown as "from ...")
export type ShopPrice = { cents: number; currency: string; varies: boolean } | null;
export type ShopPhoto = { id: string; width: number | null; height: number | null };

export type ShopCard = {
  handle: string;
  title: string;
  category: string | null;
  price: ShopPrice;
  photo: ShopPhoto | null;
};

export type ShopProduct = {
  handle: string;
  title: string;
  descriptionHtml: string;
  // Translated, e.g. "Haus & Garten > Pflanzgefäße", and the English path for links back to the collection
  category: string | null;
  categoryPath: { label: string; value: string }[];
  attributes: { key: string; label: string; value: string }[];
  // Variant options (size, colour...) with the name and each value as the shopper reads them, in variant order
  options: { name: string; label: string; values: { value: string; label: string }[] }[];
  variants: { sku: string; options: Record<string, string>; priceCents: number | null; currency: string | null }[];
  price: ShopPrice;
  photos: ShopPhoto[];
  seo: { metaTitle: string; metaDescription: string };
};

// The lowest price, in the currency of the first variant that has one
function fromPrice(rows: { priceCents: number | null; currency: string | null }[]): ShopPrice {
  const priced = rows.filter((v) => v.priceCents !== null && v.currency);
  if (!priced.length) return null;
  const currency = priced[0].currency!;
  const prices = priced.filter((v) => v.currency === currency).map((v) => v.priceCents!);
  return { cents: Math.min(...prices), currency, varies: new Set(prices).size > 1 || prices.length < rows.length };
}

async function translationRows(db: Db, productIds: string[], language: Language, fields?: string[]): Promise<(TranslationRow & { productId: string })[]> {
  if (language === "en" || !productIds.length) return [];
  return db
    .select({
      productId: translations.productId,
      field: translations.field,
      value: translations.value,
      sourceHash: translations.sourceHash,
      writtenBy: translations.writtenBy,
      issue: translations.issue,
    })
    .from(translations)
    .where(and(inArray(translations.productId, productIds), eq(translations.locale, language), fields ? inArray(translations.field, fields) : undefined));
}

// Usable photos (matched, processed) in the order the product page shows them: earlier imports first, then the
// order matching gave them. The same picture uploaded twice is shown once
async function productPhotos(db: Db, productIds: string[]) {
  if (!productIds.length) return [];
  const rows = await db
    .selectDistinctOn([photos.productId, photos.contentHash], {
      id: photos.id,
      productId: photos.productId,
      width: photos.width,
      height: photos.height,
      position: photos.position,
      fileName: photos.fileName,
      importedAt: imports.createdAt,
    })
    .from(photos)
    .innerJoin(imports, eq(imports.id, photos.importId))
    .where(and(inArray(photos.productId, productIds), eq(photos.status, "matched"), isNotNull(photos.storagePath)))
    .orderBy(photos.productId, photos.contentHash, asc(imports.createdAt));
  return rows.sort((a, b) => a.importedAt.getTime() - b.importedAt.getTime() || a.position - b.position || a.fileName.localeCompare(b.fileName));
}

const toPhoto = (p: { id: string; width: number | null; height: number | null }): ShopPhoto => ({ id: p.id, width: p.width, height: p.height });

export async function loadShopCountries(db: Db): Promise<ShopCountry[]> {
  return listCountries(db);
}

// The categories that have products on sale, for the filter on the collection page
export async function loadShopCategories(db: Db, language: Language) {
  const rows = await db
    .select({ category: products.category, products: count() })
    .from(products)
    .where(and(onSale, isNotNull(products.category)))
    .groupBy(products.category)
    .orderBy(asc(products.category));
  return rows.map((r) => ({ value: r.category!, label: translateCategory(r.category, language)!, products: r.products }));
}

// One page of the collection. A category also shows the categories below it ("Home & Garden" includes
// "Home & Garden > Planters"). The category must come from loadShopCategories, never straight from a link
export async function loadShopPage(db: Db, language: Language, options: { category?: string | null; page?: number } = {}) {
  const inCategory = options.category ? or(eq(products.category, options.category), like(products.category, `${options.category} > %`)) : undefined;
  const where = and(onSale, inCategory);
  const [{ total }] = await db.select({ total: count() }).from(products).where(where);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), pageCount);

  const rows = await db
    .select({
      id: products.id,
      handle: products.handle,
      title: products.title,
      descriptionHtml: products.descriptionHtml,
      tags: products.tags,
      attributes: products.attributes,
      category: products.category,
    })
    .from(products)
    .where(where)
    // Newest on sale first: the same order in every language (sorting by title would follow the English titles)
    .orderBy(sql`${products.approvedAt} desc nulls last`, asc(products.title), asc(products.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  const ids = rows.map((r) => r.id);

  // A card only shows the title, so only title translations are read
  const [allVariants, titles, allPhotos] = await Promise.all([
    ids.length
      ? db
          .select({ productId: variants.productId, options: variants.options, priceCents: variants.priceCents, currency: variants.currency })
          .from(variants)
          .where(inArray(variants.productId, ids))
          .orderBy(asc(variants.position))
      : [],
    translationRows(db, ids, language, ["title"]),
    productPhotos(db, ids),
  ]);

  const cards: ShopCard[] = rows.map((product) => {
    const own = allVariants.filter((v) => v.productId === product.id);
    const shown = localizeProduct(
      product,
      own,
      titles.filter((t) => t.productId === product.id),
      language,
    );
    const photo = allPhotos.find((p) => p.productId === product.id);
    return { handle: product.handle, title: shown.title, category: shown.category, price: fromPrice(own), photo: photo ? toPhoto(photo) : null };
  });
  return { products: cards, total, page, pageCount };
}

// One product page, or null when the product doesn't exist, isn't approved or was deleted (the page answers 404)
export async function loadShopProduct(db: Db, handle: string, language: Language): Promise<ShopProduct | null> {
  const [product] = await db.select().from(products).where(and(eq(products.handle, handle), onSale)).limit(1);
  if (!product) return null;

  const [own, rows, allPhotos] = await Promise.all([
    db.select().from(variants).where(eq(variants.productId, product.id)).orderBy(asc(variants.position)),
    translationRows(db, [product.id], language),
    productPhotos(db, [product.id]),
  ]);
  const shown = localizeProduct(product, own, rows, language);

  // The category path, each part linking to that part of the collection
  const parts = product.category?.split(" > ") ?? [];
  const categoryPath = parts.map((_, i) => {
    const value = parts.slice(0, i + 1).join(" > ");
    return { value, label: translateCategory(value, language)!.split(" > ").at(-1)! };
  });

  // Option values in the order the variants list them (20 cm, 30 cm, 40 cm), not alphabetically
  const options = shown.options.map((option) => {
    const order = [...new Set(own.map((v) => v.options[option.name]).filter((v): v is string => Boolean(v)))];
    return { name: option.name, label: option.label, values: order.map((value) => ({ value, label: option.values[value] ?? value })) };
  });

  return {
    handle: product.handle,
    title: shown.title,
    descriptionHtml: shown.descriptionHtml,
    category: shown.category,
    categoryPath,
    attributes: shown.attributes,
    options,
    variants: own.map((v) => ({ sku: v.sku, options: v.options, priceCents: v.priceCents, currency: v.currency })),
    price: fromPrice(own),
    photos: allPhotos.map(toPhoto),
    seo: shown.seo,
  };
}
