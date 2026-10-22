import { createHash } from "node:crypto";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { PROMPT_VERSION } from "@/server/ai/prompt";
import { importRows, imports, photos, products } from "@/server/db/schema";
import type { BuildBatchJob } from "@/server/queue/queues";
import { linkPhotos, planPhotoMatches, saveLinkPhotos, saveMatches } from "@/server/photos/match";
import { readStoredFile } from "@/server/storage";
import { detectDecimalSeparator } from "./clean/price";
import { cleanRow } from "./clean/row";
import { detectSheetType } from "./detect-file-type";
import { batchKey, DELETED_PHOTO, DELETED_SKIP, finishImportIfComplete, groupByProduct, planBuildBatches, sourceHashFor } from "./build";
import { groupRows } from "./group";
import { prepareRows } from "./prepare-rows";
import { ImportFileError, readSheet } from "./read-sheet";
import type { CleanedRow, Issue } from "./types";

const INSERT_CHUNK = 500;
const UPDATE_CHUNK = 1000;
// Photos the sheet names but nobody uploaded: the first ones are listed, that's enough to spot the problem
const MAX_MISSING_LISTED = 200;

type Import = typeof imports.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// A newer attempt took over this import (this worker froze or lost its job). Stop without saving anything
export class AttemptSuperseded extends Error {}

export type AttemptContext = {
  db: Db;
  importId: string;
  // This attempt's number, see imports.attempt
  attempt: number;
  // pg-boss aborts this when the job is no longer ours (e.g. we went quiet and it was handed to another worker)
  signal?: AbortSignal;
  // Queues AI batches inside the given transaction. Without it the import stops before the AI step (used by tests)
  enqueueBuild?: EnqueueBuild;
  // Queues photos to download (from links in the sheet) inside the given transaction
  enqueuePhotos?: EnqueuePhotos;
};

export type EnqueueBuild = (tx: Tx, jobs: { data: BuildBatchJob; singletonKey: string }[]) => Promise<void>;
export type EnqueuePhotos = (tx: Tx, importId: string, photoIds: string[]) => Promise<void>;

// Runs the parse-import job: read the file, clean every row, group rows into products.
// Each stage is safe to run again after a crash, and the import remembers which stage it reached,
// so a restarted worker carries on where it stopped
export async function runParseImport(
  db: Db,
  importId: string,
  options: { signal?: AbortSignal; enqueueBuild?: EnqueueBuild; enqueuePhotos?: EnqueuePhotos } = {},
): Promise<void> {
  const attempt = await startAttempt(db, importId);
  if (attempt === null) return;
  await runStages({ db, importId, attempt, signal: options.signal, enqueueBuild: options.enqueueBuild, enqueuePhotos: options.enqueuePhotos });
}

// Marks the import as running and takes the next attempt number. Returns null if there's nothing to do
export async function startAttempt(db: Db, importId: string): Promise<number | null> {
  const [row] = await db
    .update(imports)
    .set({
      status: "running",
      attempt: sql`${imports.attempt} + 1`,
      startedAt: sql`coalesce(${imports.startedAt}, now())`,
    })
    .where(and(eq(imports.id, importId), sql`${imports.status} not in ('done', 'failed')`))
    .returning({ attempt: imports.attempt });
  return row?.attempt ?? null;
}

// Exported so tests can run an attempt that has already been replaced by a newer one
export async function runStages(ctx: AttemptContext): Promise<void> {
  try {
    let imp = await loadImport(ctx);
    if (!imp.stage || imp.stage === "parse") {
      await parseStage(ctx, imp);
      imp = await loadImport(ctx);
    }
    if (imp.stage === "clean") {
      await cleanStage(ctx, imp);
      imp = await loadImport(ctx);
    }
    if (imp.stage === "group") {
      await groupStage(ctx, imp);
      imp = await loadImport(ctx);
    }
    if (imp.stage === "photos") {
      await photoStage(ctx, imp);
      imp = await loadImport(ctx);
    }
    if (imp.stage === "build" && !imp.buildPlannedAt) {
      await planStage(ctx, imp);
    }
  } catch (err) {
    // Problems with the file itself won't go away on retry: fail the import with a clear message
    if (err instanceof ImportFileError) {
      await fenced(ctx, (tx) => markFailed(tx, ctx.importId, err.message));
      return;
    }
    throw err;
  }
}

export async function failImport(db: Db, importId: string, message: string) {
  await markFailed(db, importId, message);
}

async function markFailed(db: Db | Tx, importId: string, message: string) {
  await db
    .update(imports)
    .set({ status: "failed", error: message, finishedAt: new Date() })
    .where(and(eq(imports.id, importId), sql`${imports.status} not in ('done', 'failed')`));
}

// Runs `write` in a transaction, but only if this attempt is still the newest one. It locks the import row
// first, so two attempts can never save at the same time, and an old attempt that wakes up late finds a
// newer number and stops before writing anything
async function fenced<T>(ctx: AttemptContext, write: (tx: Tx) => Promise<T>): Promise<T> {
  ctx.signal?.throwIfAborted();
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ attempt: imports.attempt, status: imports.status })
      .from(imports)
      .where(eq(imports.id, ctx.importId))
      .for("update");
    if (!row || row.attempt !== ctx.attempt || row.status === "failed" || row.status === "done") {
      throw new AttemptSuperseded(`Attempt ${ctx.attempt} of import ${ctx.importId} was replaced by attempt ${row?.attempt}`);
    }
    return write(tx);
  });
}

async function loadImport(ctx: AttemptContext): Promise<Import> {
  const [imp] = await ctx.db.select().from(imports).where(eq(imports.id, ctx.importId));
  if (!imp) throw new AttemptSuperseded(`Import ${ctx.importId} no longer exists`);
  return imp;
}

// Stage 1: read the file and store every row as it is
async function parseStage(ctx: AttemptContext, imp: Import) {
  await fenced(ctx, (tx) => tx.update(imports).set({ stage: "parse" }).where(eq(imports.id, imp.id)));
  if (!imp.sheetPath) throw new ImportFileError("The sheet was never uploaded");

  const bytes = new Uint8Array(await readStoredFile(imp.sheetPath));
  const type = detectSheetType(bytes);
  if (!type.ok) throw new ImportFileError(type.reason);
  const sheet = readSheet(bytes, type.type);

  for (let i = 0; i < sheet.rows.length; i += INSERT_CHUNK) {
    const chunk = sheet.rows.slice(i, i + INSERT_CHUNK).map((row) => ({
      importId: imp.id,
      rowNumber: row.rowNumber,
      raw: row.values,
      rowHash: hashValues(sheet.headers.map((h) => row.values[h])),
    }));
    // Rows saved before a crash are skipped, not duplicated
    await fenced(ctx, (tx) => tx.insert(importRows).values(chunk).onConflictDoNothing());
  }

  await fenced(ctx, (tx) =>
    tx.update(imports).set({ stage: "clean", totalRows: sheet.rows.length, parseInfo: sheet.info }).where(eq(imports.id, imp.id)),
  );
}

// Stage 2: clean every row. All rows are written in one transaction, so a crash leaves either
// all of them cleaned or none
async function cleanStage(ctx: AttemptContext, imp: Import) {
  const info = imp.parseInfo!;
  const rows = await ctx.db
    .select({ id: importRows.id, raw: importRows.raw })
    .from(importRows)
    .where(eq(importRows.importId, imp.id))
    .orderBy(asc(importRows.rowNumber));

  const priceHeader = info.columns.price;
  const decimalSeparator = detectDecimalSeparator(rows.map((r) => (priceHeader ? r.raw[priceHeader] : null)));

  // Looks across all rows first: links WooCommerce variations to their parent, fills shared product info
  // down into variant rows, spots photo-only rows
  const inputs = prepareRows(rows.map((r) => r.raw), info);

  const updates = rows.map((row, i) => {
    const { cleaned, failReason } = cleanRow(inputs[i], {
      defaultCurrency: imp.defaultCurrency,
      hints: info.hints,
      decimalSeparator,
    });
    return {
      id: row.id,
      cleaned,
      status: failReason ? ("failed" as const) : ("pending" as const),
      reason: failReason ?? reviewReason(cleaned.issues),
    };
  });

  await fenced(ctx, async (tx) => {
    for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
      await bulkUpdateRows(tx, updates.slice(i, i + UPDATE_CHUNK));
    }
    await tx.update(imports).set({ stage: "group" }).where(eq(imports.id, imp.id));
  });
}

// Stage 3: work out which rows belong to the same product, and find duplicates and conflicts
async function groupStage(ctx: AttemptContext, imp: Import) {
  const rows = await ctx.db
    .select({ id: importRows.id, rowNumber: importRows.rowNumber, cleaned: importRows.cleaned })
    .from(importRows)
    .where(and(eq(importRows.importId, imp.id), ne(importRows.status, "failed")))
    .orderBy(asc(importRows.rowNumber));

  const groups = groupRows(
    rows.map((r) => ({ rowNumber: r.rowNumber, cleaned: r.cleaned! })),
    { hasParentColumn: imp.parseInfo?.columns.parentSku !== undefined },
  );
  const byRow = new Map(groups.map((g) => [g.rowNumber, g]));

  const updates = rows.map((row) => {
    const group = byRow.get(row.rowNumber)!;
    // This stage commits together with the move to the next stage, so it never adds its issues twice
    const before = row.cleaned!;
    const cleaned: CleanedRow = {
      ...before,
      // A currency taken from the product's other variants replaces the import's default (and its note)
      currency: group.currencyFromSiblings ?? before.currency,
      issues: [
        ...(group.currencyFromSiblings ? before.issues.filter((i) => i.code !== "currency_assumed") : before.issues),
        ...group.issues,
      ],
      duplicateOfRow: group.duplicateOfRow,
    };
    return { id: row.id, cleaned, productKey: group.productKey, status: "pending" as const, reason: reviewReason(cleaned.issues) };
  });

  await fenced(ctx, async (tx) => {
    for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
      await bulkUpdateRows(tx, updates.slice(i, i + UPDATE_CHUNK));
    }
    await tx.update(imports).set({ stage: "photos" }).where(eq(imports.id, imp.id));
  });
}

// Stage 4: match the uploaded photos to products by file name (see photos/match.ts). Only names are needed, so
// it doesn't wait for the photos to be processed, which happens in parallel in its own jobs. Photo links in
// the sheet become photos too, queued for downloading in the same transaction
async function photoStage(ctx: AttemptContext, imp: Import) {
  const plan = await planPhotoMatches(ctx.db, imp.id, imp.parseInfo?.columns.image);
  await fenced(ctx, async (tx) => {
    await saveMatches(tx, plan.matches);
    const linkPhotoIds = await saveLinkPhotos(tx, imp.id, plan.links);
    if (linkPhotoIds.length) await ctx.enqueuePhotos?.(tx, imp.id, linkPhotoIds);
    await tx
      .update(imports)
      .set({
        stage: "build",
        missingPhotos: plan.missing.length ? plan.missing.slice(0, MAX_MISSING_LISTED) : null,
        photoLinksOverLimit: plan.linksOverLimit,
      })
      .where(eq(imports.id, imp.id));
  });
}

// Stage 5: decide which products go to the AI and queue them in batches. A product whose supplier rows are
// exactly the same as last time (a re-upload) keeps its result and costs no AI call, and one whose text says
// nothing new (only prices changed) keeps its listing and only gets new prices and variants. The batches are queued
// in the same transaction that records the plan, so they're never queued twice or lost
async function planStage(ctx: AttemptContext, imp: Import) {
  if (!ctx.enqueueBuild) return;
  const rows = await ctx.db
    .select({
      rowNumber: importRows.rowNumber,
      raw: importRows.raw,
      productKey: importRows.productKey,
      rowHash: importRows.rowHash,
      cleaned: importRows.cleaned,
    })
    .from(importRows)
    .where(and(eq(importRows.importId, imp.id), ne(importRows.status, "failed")));
  const groups = groupByProduct(rows);

  const keys = [...groups.keys()];
  const existing = keys.length
    ? await ctx.db
        .select({
          productKey: products.productKey,
          sourceHash: products.sourceHash,
          promptVersion: products.promptVersion,
          status: products.status,
          reviewReason: products.reviewReason,
          deletedAt: products.deletedAt,
        })
        .from(products)
        .where(inArray(products.productKey, keys))
    : [];
  const byKey = new Map(existing.map((p) => [p.productKey, p]));

  const settled: { key: string; status: "done" | "needs_review"; reason: string | null }[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];
  const toBuild = new Map<string, typeof rows>();
  for (const [key, group] of groups) {
    const product = byKey.get(key);
    if (product?.deletedAt) {
      // The merchant deleted this product: a re-upload doesn't silently bring it back
      settled.push({ key, status: "done", reason: DELETED_SKIP });
      deleted.push(key);
    } else if (product && product.promptVersion === PROMPT_VERSION && product.sourceHash === sourceHashFor(group)) {
      const review = product.status === "needs_review";
      settled.push({ key, status: review ? "needs_review" : "done", reason: review ? product.reviewReason : null });
      unchanged.push(key);
    } else {
      toBuild.set(key, group);
    }
  }

  // AI batches, plus "prices only" batches for products we already have a listing for and this file has
  // nothing new to say about (a price list for products imported from a richer sheet)
  const batches = await planBuildBatches(ctx.db, toBuild, imp.parseInfo);
  await fenced(ctx, async (tx) => {
    for (const s of settled) {
      await tx
        .update(importRows)
        .set({ status: s.status, reason: s.reason })
        .where(and(eq(importRows.importId, imp.id), eq(importRows.productKey, s.key), eq(importRows.status, "pending")));
    }
    // Unchanged products still belong to this upload, so its product list isn't empty, and get its photos
    for (let i = 0; i < unchanged.length; i += UPDATE_CHUNK) {
      await tx
        .update(products)
        .set({ lastImportId: imp.id })
        .where(inArray(products.productKey, unchanged.slice(i, i + UPDATE_CHUNK)));
    }
    // A photo of a product the merchant deleted has nowhere to go. The rest of the unchanged ones are linked now
    if (deleted.length) {
      await tx
        .update(photos)
        .set({ status: "unmatched", reason: DELETED_PHOTO })
        .where(and(eq(photos.importId, imp.id), eq(photos.status, "matched"), inArray(photos.productKey, deleted)));
    }
    await linkPhotos(tx, imp.id, "all");
    await ctx.enqueueBuild!(
      tx,
      batches.map((b) => ({ data: { importId: imp.id, ...b }, singletonKey: batchKey(imp.id, b.productKeys) })),
    );
    await tx.update(imports).set({ buildPlannedAt: new Date() }).where(eq(imports.id, imp.id));
    // Nothing left for the AI (everything unchanged): the import is done right away
    await finishImportIfComplete(tx, imp.id);
  });
}

// The text shown next to a row that needs review: every "review" problem, joined
function reviewReason(issues: Issue[]): string | null {
  const messages = issues.filter((i) => i.severity === "review").map((i) => i.message);
  return messages.length ? [...new Set(messages)].join("; ") : null;
}

function hashValues(values: (string | undefined)[]) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

type RowUpdate = {
  id: number;
  cleaned: CleanedRow;
  status: "pending" | "failed";
  reason: string | null;
  productKey?: string;
};

// Updates many rows with one query instead of one query per row (10,000 rows -> 10 queries)
async function bulkUpdateRows(tx: Tx, updates: RowUpdate[]) {
  if (updates.length === 0) return;
  await tx.execute(sql`
    update ${importRows} as r set
      cleaned = u.cleaned::jsonb,
      status = u.status::row_status,
      reason = u.reason,
      product_key = coalesce(u.product_key, r.product_key),
      updated_at = now()
    from unnest(
      ${sql.param(updates.map((u) => u.id))}::bigint[],
      ${sql.param(updates.map((u) => JSON.stringify(u.cleaned)))}::text[],
      ${sql.param(updates.map((u) => u.status))}::text[],
      ${sql.param(updates.map((u) => u.reason))}::text[],
      ${sql.param(updates.map((u) => u.productKey ?? null))}::text[]
    ) as u(id, cleaned, status, reason, product_key)
    where r.id = u.id
  `);
}
