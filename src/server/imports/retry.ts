import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { Db } from "@/server/db/client";
import { importRows, imports, products, translationState } from "@/server/db/schema";
import { batchKey, groupByProduct, planBuildBatches } from "@/server/pipeline/build";
import { queues } from "@/server/queue/queues";
import { retryFailed } from "@/server/translations/state";

// A retry the merchant asked for that can't happen (unknown import, a file that can't be read...). Shown as is
export class RetryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// "Try again" on an import. Rows the AI failed on (provider down for too long, refused, no usable answer after
// every try) go back to pending and get new AI batches, queued in the same transaction, so a crash in between
// loses nothing. Rows that failed while the sheet was read (no product, a bad row) would fail the same way, so
// they stay failed: the merchant fixes the sheet instead. This import's failed translations are tried again too
export async function retryImport(db: Db, boss: PgBoss, importId: string) {
  const [imp] = await db.select().from(imports).where(eq(imports.id, importId));
  if (!imp) throw new RetryError("Import not found", 404);
  if (imp.status === "failed") {
    throw new RetryError(`This file couldn't be imported${imp.error ? ` (${imp.error})` : ""}. Fix it and upload it again`, 409);
  }
  if (imp.status === "waiting_for_files") throw new RetryError("This import hasn't started yet. Start it first", 409);
  if (imp.stage !== "build" || !imp.buildPlannedAt) throw new RetryError("This import is still being read. Nothing has failed yet", 409);

  const rowsRetried = await db.transaction(async (tx) => {
    const failed = await tx
      .select({ rowNumber: importRows.rowNumber, raw: importRows.raw, productKey: importRows.productKey, cleaned: importRows.cleaned })
      .from(importRows)
      .where(and(eq(importRows.importId, importId), eq(importRows.status, "failed"), isNotNull(importRows.productKey)))
      .for("update");
    if (!failed.length) return 0;

    await tx
      .update(importRows)
      .set({ status: "pending", reason: null })
      .where(and(eq(importRows.importId, importId), eq(importRows.status, "failed"), isNotNull(importRows.productKey)));
    await tx.update(imports).set({ status: "running", finishedAt: null }).where(eq(imports.id, importId));
    // Planned like the first time: products whose listing is kept still don't go to the AI
    const batches = await planBuildBatches(tx, groupByProduct(failed), imp.parseInfo);
    await boss.insert(
      queues.buildBatch.name,
      batches.map((b) => ({ data: { importId, ...b }, singletonKey: batchKey(importId, b.productKeys) })),
      { db: fromDrizzle(tx, sql) },
    );
    return failed.length;
  });

  // Translations of this import's products that failed (AI refused or gave up): queued again. The import shows
  // "translating" until they're done
  const failedTranslations = await db
    .selectDistinct({ productId: translationState.productId })
    .from(translationState)
    .innerJoin(products, eq(products.id, translationState.productId))
    .where(and(eq(products.lastImportId, importId), isNull(products.deletedAt), eq(translationState.status, "failed")));
  let translationBatches = 0;
  if (failedTranslations.length) {
    await db.update(imports).set({ status: "running", finishedAt: null }).where(and(eq(imports.id, importId), eq(imports.status, "done")));
    translationBatches = await retryFailed(db, boss, { productIds: failedTranslations.map((t) => t.productId) });
  }

  const [{ notRetryable }] = await db
    .select({ notRetryable: count() })
    .from(importRows)
    .where(and(eq(importRows.importId, importId), eq(importRows.status, "failed"), isNull(importRows.productKey)));

  return {
    rowsRetried,
    translationsRetried: failedTranslations.length,
    translationBatches,
    // Failed while the sheet was read: fix the sheet and upload it again
    rowsNotRetryable: notRetryable,
  };
}
