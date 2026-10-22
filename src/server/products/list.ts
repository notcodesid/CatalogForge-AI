import { and, asc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/server/db/client";
import { products, productStatus, translationState, variants } from "@/server/db/schema";
import { productPhotos } from "@/server/imports/queries";

const PAGE_SIZES = [10, 25, 50, 100] as const;
const PRODUCT_SORTS = ["title", "status", "category", "updatedAt", "confidence", "price"] as const;

// "ready,approved" -> ["ready", "approved"]
const statusList = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.enum(productStatus.enumValues)));

// The Products tab's query string. Everything is optional: no filters, newest changes first, 25 per page
export const productListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((n) => (PAGE_SIZES as readonly number[]).includes(n), "Use 10, 25, 50 or 100")
    .default(25),
  sort: z.enum(PRODUCT_SORTS).default("updatedAt"),
  // Newest first for updatedAt, A to Z (or lowest first) for everything else
  order: z.enum(["asc", "desc"]).optional(),
  // Part of a title, handle or SKU
  search: z.string().trim().max(200).optional(),
  status: statusList.optional(),
  // A category, or a part of the tree: "Home & Garden" includes "Home & Garden > Planters"
  category: z.string().trim().max(300).optional(),
  importId: z.uuid().optional(),
  // Only products whose least certain field is at or below this (70 = everything the AI was unsure about)
  maxConfidence: z.coerce.number().int().min(0).max(100).optional(),
  // true: only approved products with a new version of their listing waiting for the merchant
  updateWaiting: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  // true: only deleted products (to restore them). Otherwise deleted products are left out
  deleted: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type ProductListQuery = z.infer<typeof productListQuery>;

const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

// The product's least certain field. Sorting and filtering on it is how the merchant finds what to check first
const lowestConfidence = sql<number | null>`(select min(c.value::numeric)::int from jsonb_each_text(${products.confidence}) as c)`;

// Lists products for the Products tab: one page, sorted, searched and filtered, in a fixed number of queries
// (one for the page, one for the total, one for photos, one for translations), however many products there are
export async function listProducts(db: Db, query: ProductListQuery) {
  // Per product: price range, number of variants, how many have no price, and the currencies used
  const prices = db
    .select({
      productId: variants.productId,
      minPrice: sql<number | null>`min(${variants.priceCents})`.as("min_price"),
      maxPrice: sql<number | null>`max(${variants.priceCents})`.as("max_price"),
      variantCount: sql<number>`count(*)::int`.as("variant_count"),
      unpriced: sql<number>`(count(*) filter (where ${variants.priceCents} is null))::int`.as("unpriced"),
      currencies: sql<string[]>`coalesce(array_agg(distinct ${variants.currency}::text) filter (where ${variants.currency} is not null), '{}')`.as("currencies"),
    })
    .from(variants)
    .groupBy(variants.productId)
    .as("prices");

  const conditions: (SQL | undefined)[] = [query.deleted ? isNotNull(products.deletedAt) : isNull(products.deletedAt)];
  if (query.search) {
    const pattern = `%${escapeLike(query.search)}%`;
    conditions.push(
      or(
        ilike(products.title, pattern),
        ilike(products.handle, pattern),
        sql`exists (select 1 from ${variants} v where v.product_id = ${products.id} and v.sku ilike ${pattern})`,
      ),
    );
  }
  if (query.status?.length) conditions.push(inArray(products.status, query.status));
  if (query.category) conditions.push(or(eq(products.category, query.category), sql`${products.category} like ${`${escapeLike(query.category)} > %`}`));
  if (query.importId) conditions.push(eq(products.lastImportId, query.importId));
  if (query.maxConfidence !== undefined) conditions.push(sql`${lowestConfidence} <= ${query.maxConfidence}`);
  if (query.updateWaiting) conditions.push(isNotNull(products.pendingListing));
  const where = and(...conditions);

  const direction = query.order ?? (query.sort === "updatedAt" ? "desc" : "asc");
  const sortBy = {
    title: sql`lower(${products.title})`,
    status: sql`${products.status}`,
    category: sql`${products.category}`,
    updatedAt: sql`${products.updatedAt}`,
    confidence: lowestConfidence,
    price: sql`${prices.minPrice}`,
  }[query.sort];

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: products.id,
        handle: products.handle,
        title: products.title,
        status: products.status,
        category: products.category,
        confidence: products.confidence,
        lowestConfidence,
        reviewReason: products.reviewReason,
        updateWaiting: sql<boolean>`${products.pendingListing} is not null`,
        merchantEditedFields: products.merchantEditedFields,
        lastImportId: products.lastImportId,
        updatedAt: products.updatedAt,
        deletedAt: products.deletedAt,
        minPrice: prices.minPrice,
        maxPrice: prices.maxPrice,
        variantCount: prices.variantCount,
        unpriced: prices.unpriced,
        currencies: prices.currencies,
      })
      .from(products)
      .leftJoin(prices, eq(prices.productId, products.id))
      .where(where)
      // Products without a value (no category, no price) go last either way; the id keeps pages stable
      .orderBy(sql`${sortBy} ${sql.raw(direction)} nulls last`, asc(products.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(products).where(where),
  ]);

  const ids = rows.map((r) => r.id);
  const [photos, states] = ids.length
    ? await Promise.all([
        productPhotos(db, ids),
        db.select({ productId: translationState.productId, locale: translationState.locale, status: translationState.status }).from(translationState).where(inArray(translationState.productId, ids)),
      ])
    : [[], []];

  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    pages: Math.ceil(total / query.pageSize),
    products: rows.map((r) => {
      const currencies = r.currencies ?? [];
      return {
        id: r.id,
        handle: r.handle,
        title: r.title,
        status: r.status,
        category: r.category,
        lowestConfidence: r.lowestConfidence,
        confidence: r.confidence,
        reviewReason: r.reviewReason,
        // The AI wrote a new version of this approved product's listing, waiting for the merchant
        updateWaiting: r.updateWaiting,
        // Prices in cents. The currency is null when there's none, or when variants use different ones (see currencies)
        minPriceCents: r.minPrice,
        maxPriceCents: r.maxPrice,
        currency: currencies.length === 1 ? currencies[0] : null,
        currencies,
        variantCount: r.variantCount ?? 0,
        variantsWithoutPrice: r.unpriced ?? 0,
        thumbnailUrl: photos.find((p) => p.productId === r.id)?.thumbnailUrl ?? null,
        // Per language: pending, done or failed
        translations: Object.fromEntries(states.filter((s) => s.productId === r.id).map((s) => [s.locale, s.status])),
        editedFields: r.merchantEditedFields,
        lastImportId: r.lastImportId,
        updatedAt: r.updatedAt,
        deletedAt: r.deletedAt,
      };
    }),
  };
}
