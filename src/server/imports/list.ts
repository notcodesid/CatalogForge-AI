import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { aiStatus, importRows, imports, photos, photoStatus, products, rowStatus, translationState } from "@/server/db/schema";
import { phaseOf, productOutcomes, retryingBatches } from "./queries";

type RowStatus = (typeof rowStatus.enumValues)[number];
type PhotoStatus = (typeof photoStatus.enumValues)[number];

// The upload queue: the newest imports first, each with its live counts. One query per kind of count for the
// whole page (not the full summary per import), because the Upload tab asks for this every second or two
export async function listImports(db: Db, options: { limit: number; offset: number }) {
  const [{ total }] = await db.select({ total: count() }).from(imports);
  const page = await db
    .select({
      id: imports.id,
      fileName: imports.sheetFileName,
      status: imports.status,
      stage: imports.stage,
      buildPlannedAt: imports.buildPlannedAt,
      error: imports.error,
      totalRows: imports.totalRows,
      linksOverLimit: imports.photoLinksOverLimit,
      missingPhotos: sql<number>`coalesce(jsonb_array_length(${imports.missingPhotos}), 0)`.mapWith(Number),
      createdAt: imports.createdAt,
      startedAt: imports.startedAt,
      finishedAt: imports.finishedAt,
    })
    .from(imports)
    .orderBy(desc(imports.createdAt), desc(imports.id))
    .limit(options.limit)
    .offset(options.offset);
  const ids = page.map((imp) => imp.id);
  if (!ids.length) return { total, imports: [] };

  const [rowCounts, productCounts, outcomes, photoCounts, translationCounts, retrying] = await Promise.all([
    db
      .select({ importId: importRows.importId, status: importRows.status, n: count() })
      .from(importRows)
      .where(inArray(importRows.importId, ids))
      .groupBy(importRows.importId, importRows.status),
    db
      .select({ importId: importRows.importId, n: sql<number>`count(distinct ${importRows.productKey})`.mapWith(Number) })
      .from(importRows)
      .where(inArray(importRows.importId, ids))
      .groupBy(importRows.importId),
    // New products, and ones already in the catalog that the file updated
    productOutcomes(db, ids),
    db
      .select({
        importId: photos.importId,
        status: photos.status,
        n: count(),
        waiting: count(sql`case when ${photos.processedAt} is null and ${photos.status} <> 'rejected' then 1 end`),
      })
      .from(photos)
      .where(inArray(photos.importId, ids))
      .groupBy(photos.importId, photos.status),
    db
      .select({ importId: products.lastImportId, locale: translationState.locale, status: translationState.status, n: count() })
      .from(translationState)
      .innerJoin(products, eq(products.id, translationState.productId))
      .where(and(inArray(products.lastImportId, ids), isNull(products.deletedAt)))
      .groupBy(products.lastImportId, translationState.locale, translationState.status)
      // Every card lists the languages in the same order
      .orderBy(translationState.locale),
    // AI batches tried again after an error, only for the imports still running
    retryingBatches(db, page.filter((imp) => imp.status === "running").map((imp) => imp.id)),
  ]);

  // "Paused — resuming in X minutes": the pause is shared by every import, so it's read once
  const [pause] = page.some((imp) => imp.status === "paused")
    ? await db.select({ until: aiStatus.pausedUntil, reason: aiStatus.reason }).from(aiStatus).orderBy(sql`${aiStatus.pausedUntil} desc nulls last`).limit(1)
    : [];

  return {
    total,
    imports: page.map((imp) => {
      const rows = Object.fromEntries(rowStatus.enumValues.map((s) => [s, 0])) as Record<RowStatus, number>;
      for (const r of rowCounts) if (r.importId === imp.id) rows[r.status] = r.n;

      const mine = photoCounts.filter((p) => p.importId === imp.id);
      const photoSummary = {
        total: mine.reduce((sum, p) => sum + p.n, 0),
        ...(Object.fromEntries(photoStatus.enumValues.map((s) => [s, mine.find((p) => p.status === s)?.n ?? 0])) as Record<PhotoStatus, number>),
        waitingToBeProcessed: mine.reduce((sum, p) => sum + p.waiting, 0),
        missing: imp.missingPhotos,
        linksOverLimit: imp.linksOverLimit,
      };

      const translations: Record<string, { done: number; pending: number; failed: number }> = {};
      for (const t of translationCounts) {
        if (t.importId !== imp.id) continue;
        translations[t.locale] ??= { done: 0, pending: 0, failed: 0 };
        translations[t.locale][t.status] = t.n;
      }

      return {
        id: imp.id,
        fileName: imp.fileName,
        status: imp.status,
        stage: imp.stage,
        phase: phaseOf(imp, rows, photoSummary.waitingToBeProcessed, translations),
        pausedUntil: imp.status === "paused" ? (pause?.until ?? null) : null,
        pauseReason: imp.status === "paused" ? (pause?.reason ?? null) : null,
        retrying: retrying.get(imp.id) ?? null,
        error: imp.error,
        totalRows: imp.totalRows,
        rows,
        products: productCounts.find((p) => p.importId === imp.id)?.n ?? 0,
        productOutcomes: outcomes.get(imp.id)!,
        photos: photoSummary,
        translations,
        createdAt: imp.createdAt,
        startedAt: imp.startedAt,
        finishedAt: imp.finishedAt,
      };
    }),
  };
}
