import { createHash } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { importRows, imports } from "@/server/db/schema";
import { readStoredFile } from "@/server/storage";
import { detectDecimalSeparator } from "./clean/price";
import { cleanRow } from "./clean/row";
import { detectSheetType } from "./detect-file-type";
import { groupRows } from "./group";
import { prepareRows } from "./prepare-rows";
import { ImportFileError, readSheet } from "./read-sheet";
import type { CleanedRow, Issue } from "./types";

const INSERT_CHUNK = 500;
const UPDATE_CHUNK = 1000;

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
};

// Runs the parse-import job: read the file, clean every row, group rows into products.
// Each stage is safe to run again after a crash, and the import remembers which stage it reached,
// so a restarted worker carries on where it stopped
export async function runParseImport(db: Db, importId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  const attempt = await startAttempt(db, importId);
  if (attempt === null) return;
  await runStages({ db, importId, attempt, signal: options.signal });
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
    }
    // Next stage ("build", the AI step) isn't built yet. The import waits there
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
    // This stage commits together with the move to "build", so it never adds its issues twice
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
    await tx.update(imports).set({ stage: "build" }).where(eq(imports.id, imp.id));
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
