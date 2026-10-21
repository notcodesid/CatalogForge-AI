import { and, asc, count, countDistinct, eq, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { importRows, imports, rowStatus } from "@/server/db/schema";

type RowStatus = (typeof rowStatus.enumValues)[number];

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

  return {
    id: imp.id,
    fileName: imp.sheetFileName,
    status: imp.status,
    stage: imp.stage,
    error: imp.error,
    defaultCurrency: imp.defaultCurrency,
    totalRows: imp.totalRows,
    rows,
    rowsWithReviewIssues: extra.withReviewIssues,
    products: extra.products,
    parseInfo: imp.parseInfo,
    createdAt: imp.createdAt,
    startedAt: imp.startedAt,
    finishedAt: imp.finishedAt,
  };
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
