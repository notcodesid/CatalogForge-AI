import { and, asc, count, countDistinct, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { aiStatus, importRows, imports, photos, photoStatus, products, rowStatus, translationState, variants } from "@/server/db/schema";
import { DELETED_SKIP } from "@/server/pipeline/build";
import { queues } from "@/server/queue/queues";
import { translationCounts } from "@/server/translations/coverage";

type RowStatus = (typeof rowStatus.enumValues)[number];
type PhotoStatus = (typeof photoStatus.enumValues)[number];

// What an import did to the catalog, per product: added it (new), updated one that was already there, skipped it
// because the merchant deleted it, or failed. Products still being written aren't counted yet
export type ProductOutcomes = { new: number; updated: number; deleted: number; failed: number };

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
  const retrying = imp.status === "running" ? ((await retryingBatches(db, [importId])).get(importId) ?? null) : null;

  const outcomes = (await productOutcomes(db, [importId])).get(importId)!;
  const fromFiles = imp.status === "done" && outcomes.updated > 0 ? await earlierFiles(db, importId) : [];

  return {
    id: imp.id,
    fileName: imp.sheetFileName,
    status: imp.status,
    stage: imp.stage,
    // What's happening now, in words
    phase: phaseOf(imp, rows, photoSummary.waitingToBeProcessed, translations),
    pausedUntil: pause?.until ?? null,
    pauseReason: pause?.reason ?? null,
    // AI batches that failed and are being tried again: "trying again, try 2 of 4"
    retrying,
    error: imp.error,
    defaultCurrency: imp.defaultCurrency,
    totalRows: imp.totalRows,
    rows,
    rowsWithReviewIssues: extra.withReviewIssues,
    products: extra.products,
    // Of those: new to the catalog, already in it and updated, skipped (the merchant deleted them), failed
    productOutcomes: outcomes,
    // The earlier files the updated ones came from, newest first. Only once the import is done
    earlierFiles: fromFiles,
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

// AI batches of these imports that failed (an error or a timeout) and get another try: how many products they
// hold, the try they're on and how many they get. The queue's own table counts the tries: a batch waiting for its
// next try is in "retry" (its count still that of the try that failed), one being tried again is "active" with a
// count. A batch moved for a rate-limit pause is a new job, not a failed try. Shared with the import list (list.ts)
export type Retrying = { products: number; attempt: number; attempts: number };

let queueTableExists = false;

export async function retryingBatches(db: Db, importIds: string[]): Promise<Map<string, Retrying>> {
  const found = new Map<string, Retrying>();
  if (!importIds.length) return found;
  // The queue's tables only exist once pg-boss has started on this database
  if (!queueTableExists) {
    const { rows } = await db.execute<{ exists: boolean }>(sql`select to_regclass('pgboss.job') is not null as exists`);
    queueTableExists = rows[0].exists;
    if (!queueTableExists) return found;
  }
  const { rows } = await db.execute<{ import_id: string; products: number; attempt: number; attempts: number }>(sql`
    select data->>'importId' as import_id,
      sum(coalesce(jsonb_array_length(data->'productKeys'), jsonb_array_length(data->'productIds'), 0))::int as products,
      max(case when state = 'retry' then retry_count + 2 else retry_count + 1 end)::int as attempt,
      max(retry_limit + 1)::int as attempts
    from pgboss.job
    where name in (${queues.buildBatch.name}, ${queues.translateBatch.name})
      and data->>'importId' = any(${sql.param(importIds)}::text[])
      and (state = 'retry' or (state = 'active' and retry_count > 0))
    group by 1
  `);
  for (const r of rows) found.set(r.import_id, { products: r.products, attempt: r.attempt, attempts: r.attempts });
  return found;
}

// Each product of these imports (its rows with the same product key) and the catalog product its rows were saved
// to, found the way the build step finds it: by product key, or else by one of its SKUs (a later, differently laid
// out file may have given the product its own key since, see findExisting in pipeline/build.ts)
function savedProducts(importIds: string[]) {
  return sql`
    select g.import_id, g.product_key, g.deleted, g.failed,
      case when g.written and not g.deleted then coalesce(
        (select p.id from ${products} p where p.product_key = g.product_key),
        (select v.product_id from ${importRows} r join ${variants} v on v.sku = r.cleaned->>'sku'
          where r.import_id = g.import_id and r.product_key = g.product_key limit 1)
      ) end as product_id
    from (
      select import_id, product_key,
        bool_or(status in ('done', 'needs_review')) as written,
        bool_or(reason is not distinct from ${DELETED_SKIP}) as deleted,
        bool_and(status = 'failed') as failed
      from ${importRows}
      where import_id = any(${sql.param(importIds)}::uuid[]) and product_key is not null
      group by import_id, product_key
    ) g
  `;
}

// How many of each import's products were new, already in the catalog (and updated), skipped or failed. Uploading
// the same products again, from the same file or a differently laid out one, updates them instead of adding copies,
// and the merchant should see that it did. A product was already there when it was created before the import
// started: the start, not the upload, because an import can wait for its photos while another upload adds the same
// product. Worked out from the rows, so it stays right after a later upload updates the same products again.
// Shared with the import list (list.ts)
export async function productOutcomes(db: Db, importIds: string[]): Promise<Map<string, ProductOutcomes>> {
  const counts = new Map(importIds.map((id) => [id, { new: 0, updated: 0, deleted: 0, failed: 0 }]));
  if (!importIds.length) return counts;
  const { rows } = await db.execute<{ import_id: string; created: number; updated: number; deleted: number; failed: number }>(sql`
    select s.import_id,
      count(*) filter (where p.created_at >= coalesce(i.started_at, i.created_at))::int as created,
      count(*) filter (where p.created_at < coalesce(i.started_at, i.created_at))::int as updated,
      count(*) filter (where s.deleted)::int as deleted,
      count(*) filter (where s.failed)::int as failed
    from (${savedProducts(importIds)}) s
    join ${imports} i on i.id = s.import_id
    left join ${products} p on p.id = s.product_id
    group by s.import_id
  `);
  for (const r of rows) counts.set(r.import_id, { new: r.created, updated: r.updated, deleted: r.deleted, failed: r.failed });
  return counts;
}

// The earlier files the products this import updated came from, newest first: their rows had the same product key
// or one of the same SKUs. This reads every earlier row, so it's only worked out once the import is done, not on
// every live update while it runs
async function earlierFiles(db: Db, importId: string): Promise<string[]> {
  const { rows } = await db.execute<{ file: string }>(sql`
    with me as (
      select coalesce(started_at, created_at) as started from ${imports} where id = ${importId}
    ), updated as (
      select s.product_key, p.id, p.product_key as current_key
      from (${savedProducts([importId])}) s
      join ${products} p on p.id = s.product_id
      cross join me
      where p.created_at < me.started
    )
    select i.sheet_file_name as file
    from ${importRows} r
    join ${imports} i on i.id = r.import_id
    cross join me
    where i.id <> ${importId} and coalesce(i.started_at, i.created_at) < me.started
      and r.status in ('done', 'needs_review') and r.reason is distinct from ${DELETED_SKIP}
      and (
        r.product_key in (select product_key from updated union select current_key from updated)
        or r.cleaned->>'sku' in (select v.sku from ${variants} v where v.product_id in (select id from updated))
      )
    group by i.sheet_file_name
    order by max(coalesce(i.started_at, i.created_at)) desc
  `);
  return rows.map((r) => r.file);
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
