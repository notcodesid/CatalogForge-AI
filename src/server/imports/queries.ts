import { and, asc, count, countDistinct, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { aiStatus, importRows, imports, photos, photoStatus, products, rowStatus, translationState, variants } from "@/server/db/schema";
import { translationCounts } from "@/server/translations/coverage";

type RowStatus = (typeof rowStatus.enumValues)[number];
type PhotoStatus = (typeof photoStatus.enumValues)[number];

const photoUrls = (id: string) => ({ url: `/api/photos/${id}`, thumbnailUrl: `/api/photos/${id}?size=thumb` });

// Status of one import, with row counts worked out from the rows themselves (never stored as +1 counters,
// so retries can't make them wrong)
export async function getImportSummary(db: Db, importId: string) {
  const [imp] = await db.select().from(imports).where(eq(imports.id, importId));
  if (!imp) return null;

  const counts = await db
    .select({ status: importRows.status, rows: count() })
    .from(importRows)
    .where(eq(importRows.importId, importId))
    .groupBy(importRows.status);

  const rows = Object.fromEntries(rowStatus.enumValues.map((s) => [s, 0])) as Record<RowStatus, number>;
  for (const c of counts) rows[c.status] = c.rows;

  const [extra] = await db
    .select({
      products: countDistinct(importRows.productKey),
      withReviewIssues: count(sql`case when ${importRows.reason} is not null and ${importRows.status} <> 'failed' then 1 end`),
    })
    .from(importRows)
    .where(eq(importRows.importId, importId));

  // "Paused — resuming in X minutes": when the AI's rate limit stopped this import
  const [pause] =
    imp.status === "paused"
      ? await db.select({ until: aiStatus.pausedUntil, reason: aiStatus.reason }).from(aiStatus).orderBy(sql`${aiStatus.pausedUntil} desc nulls last`).limit(1)
      : [];

  const productCounts = await db
    .select({ status: products.status, count: count() })
    .from(products)
    .where(eq(products.lastImportId, importId))
    .groupBy(products.status);

  // Photos by status, and how many still wait to be processed (resized). Rejected ones are never processed
  const photoCounts = await db
    .select({
      status: photos.status,
      count: count(),
      waiting: count(sql`case when ${photos.processedAt} is null and ${photos.status} <> 'rejected' then 1 end`),
    })
    .from(photos)
    .where(eq(photos.importId, importId))
    .groupBy(photos.status);
  const photoSummary = {
    total: photoCounts.reduce((sum, p) => sum + p.count, 0),
    ...(Object.fromEntries(photoStatus.enumValues.map((s) => [s, photoCounts.find((p) => p.status === s)?.count ?? 0])) as Record<PhotoStatus, number>),
    waitingToBeProcessed: photoCounts.reduce((sum, p) => sum + p.waiting, 0),
    // Files the sheet names that weren't uploaded
    missing: imp.missingPhotos ?? [],
    // Photo links in the sheet not downloaded because the import already had the most photos allowed
    linksOverLimit: imp.photoLinksOverLimit,
  };

  const translations = await translationCounts(db, importId);

  return {
    id: imp.id,
    fileName: imp.sheetFileName,
    status: imp.status,
    stage: imp.stage,
    // What's happening now, in words
    phase: phaseOf(imp, rows, photoSummary.waitingToBeProcessed, translations),
    pausedUntil: pause?.until ?? null,
    pauseReason: pause?.reason ?? null,
    error: imp.error,
    defaultCurrency: imp.defaultCurrency,
    totalRows: imp.totalRows,
    rows,
    rowsWithReviewIssues: extra.withReviewIssues,
    products: extra.products,
    // Products the AI step has written so far: ready (passed every check) or needs_review
    productsByStatus: Object.fromEntries(productCounts.map((p) => [p.status, p.count])),
    photos: photoSummary,
    // Per language, for this import's products: translated, still to do, failed, with a field shown in English
    translations,
    parseInfo: imp.parseInfo,
    createdAt: imp.createdAt,
    startedAt: imp.startedAt,
    finishedAt: imp.finishedAt,
  };
}

// What's happening now, in words. Shared with the import list (list.ts)
export function phaseOf(
  imp: Pick<typeof imports.$inferSelect, "status" | "stage" | "buildPlannedAt">,
  rows: Record<RowStatus, number>,
  photosWaiting: number,
  translations: Record<string, { pending: number }>,
) {
  if (imp.status === "done" || imp.status === "failed") return imp.status;
  if (imp.status === "waiting_for_files") return "waiting for photos";
  if (imp.status === "paused") return "paused";
  if (imp.stage === "photos") return "matching photos";
  if (imp.stage !== "build" || !imp.buildPlannedAt) return "reading the sheet";
  if (rows.pending + rows.processing > 0) return "writing products";
  if (photosWaiting > 0) return "processing photos";
  if (Object.values(translations).some((t) => t.pending > 0)) return "translating";
  return "finishing";
}

export async function listImportRows(
  db: Db,
  importId: string,
  options: { status?: RowStatus; limit: number; offset: number },
) {
  const where = and(eq(importRows.importId, importId), options.status ? eq(importRows.status, options.status) : undefined);
  const [{ total }] = await db.select({ total: count() }).from(importRows).where(where);
  const rows = await db
    .select({
      rowNumber: importRows.rowNumber,
      status: importRows.status,
      reason: importRows.reason,
      productKey: importRows.productKey,
      raw: importRows.raw,
      cleaned: importRows.cleaned,
    })
    .from(importRows)
    .where(where)
    .orderBy(asc(importRows.rowNumber))
    .limit(options.limit)
    .offset(options.offset);
  return { total, rows };
}

// The products an import wrote, with their variants, for the review screen
export async function listImportProducts(db: Db, importId: string, options: { limit: number; offset: number }) {
  const where = eq(products.lastImportId, importId);
  const [{ total }] = await db.select({ total: count() }).from(products).where(where);
  const page = await db.select().from(products).where(where).orderBy(asc(products.title)).limit(options.limit).offset(options.offset);
  const ids = page.map((p) => p.id);
  const allVariants = ids.length
    ? await db.select().from(variants).where(inArray(variants.productId, ids)).orderBy(asc(variants.position))
    : [];
  const allPhotos = ids.length ? await productPhotos(db, ids) : [];
  const states = ids.length ? await db.select().from(translationState).where(inArray(translationState.productId, ids)) : [];
  return {
    total,
    products: page.map((p) => ({
      id: p.id,
      handle: p.handle,
      status: p.status,
      title: p.title,
      category: p.category,
      descriptionHtml: p.descriptionHtml,
      tags: p.tags,
      attributes: p.attributes,
      claims: p.claims,
      confidence: p.confidence,
      reviewReason: p.reviewReason,
      sourceRows: p.sourceRows,
      model: p.model,
      variants: allVariants
        .filter((v) => v.productId === p.id)
        .map((v) => ({ sku: v.sku, options: v.options, priceCents: v.priceCents, currency: v.currency, weightGrams: v.weightGrams })),
      // Per language: pending, done or failed
      translations: Object.fromEntries(states.filter((t) => t.productId === p.id).map((t) => [t.locale, t.status])),
      photos: allPhotos
        .filter((ph) => ph.productId === p.id)
        .map((ph) => ({ id: ph.id, fileName: ph.fileName, sku: ph.sku, width: ph.width, height: ph.height, url: ph.url, thumbnailUrl: ph.thumbnailUrl })),
    })),
  };
}

// The usable photos of some products, in order. The same picture uploaded twice (in two imports, or under two
// names) is shown once
export async function productPhotos(db: Db, productIds: string[]) {
  const rows = await db
    .selectDistinctOn([photos.productId, photos.contentHash], {
      id: photos.id,
      productId: photos.productId,
      contentHash: photos.contentHash,
      fileName: photos.fileName,
      sku: photos.sku,
      width: photos.width,
      height: photos.height,
      position: photos.position,
      // Photos from an earlier import come first. Within one import, the order matching decided (by row)
      importedAt: imports.createdAt,
    })
    .from(photos)
    .innerJoin(imports, eq(imports.id, photos.importId))
    .where(and(inArray(photos.productId, productIds), eq(photos.status, "matched"), isNotNull(photos.storagePath)))
    .orderBy(photos.productId, photos.contentHash, asc(imports.createdAt));
  return rows
    .sort((a, b) => a.importedAt.getTime() - b.importedAt.getTime() || a.position - b.position || a.fileName.localeCompare(b.fileName))
    .map((p) => ({ id: p.id, productId: p.productId!, fileName: p.fileName, sku: p.sku, width: p.width, height: p.height, ...photoUrls(p.id) }));
}

// Every photo of an import, for the photo report: where it went and why, or why not
export async function listImportPhotos(db: Db, importId: string, options: { status?: PhotoStatus; limit: number; offset: number }) {
  const where = and(eq(photos.importId, importId), options.status ? eq(photos.status, options.status) : undefined);
  const [{ total }] = await db.select({ total: count() }).from(photos).where(where);
  const page = await db
    .select({
      id: photos.id,
      fileName: photos.fileName,
      status: photos.status,
      reason: photos.reason,
      assignedByHand: photos.assignedByHand,
      sourceUrl: photos.sourceUrl,
      sku: photos.sku,
      rowNumber: photos.rowNumber,
      productId: photos.productId,
      productTitle: products.title,
      processed: isNotNull(photos.storagePath),
      width: photos.width,
      height: photos.height,
    })
    .from(photos)
    .leftJoin(products, eq(products.id, photos.productId))
    .where(where)
    .orderBy(asc(photos.fileName))
    .limit(options.limit)
    .offset(options.offset);
  return { total, photos: page.map((p) => ({ ...p, ...(p.processed ? photoUrls(p.id) : {}) })) };
}
