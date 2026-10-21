import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { Db } from "@/server/db/client";
import { imports } from "@/server/db/schema";
import { CURRENCY_CODES } from "@/server/pipeline/clean/price";
import { detectSheetType } from "@/server/pipeline/detect-file-type";
import { queues, type ParseImportJob } from "@/server/queue/queues";
import { deleteStoredFolder, saveFile } from "@/server/storage";

export const MAX_SHEET_BYTES = 25 * 1024 * 1024;

const ACTIVE_STATUSES = ["queued", "running", "paused"] as const;

// A problem with what the client sent. The message is shown to the merchant as is
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type NewImport = {
  fileName: string;
  bytes: Uint8Array;
  defaultCurrency?: string;
};

function safeFileName(name: string) {
  const base = path.basename(name).replace(/[^\w.-]+/g, "_").slice(-100);
  return base || "sheet";
}

async function findActiveImport(db: Db, sheetHash: string) {
  const [row] = await db
    .select()
    .from(imports)
    .where(and(eq(imports.sheetHash, sheetHash), inArray(imports.status, ACTIVE_STATUSES)))
    .orderBy(desc(imports.createdAt))
    .limit(1);
  return row;
}

function isActiveFileConflict(err: unknown) {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const pg = e.cause ?? e;
  return pg.code === "23505" && pg.constraint === "imports_one_active_per_file";
}

// Saves the uploaded sheet and queues the parse job. Returns right away, the work happens in the worker
export async function createImport(db: Db, boss: PgBoss, input: NewImport) {
  if (input.bytes.length === 0) throw new UploadError("The file is empty");
  if (input.bytes.length > MAX_SHEET_BYTES) {
    throw new UploadError(`The file is too big. The limit is ${MAX_SHEET_BYTES / 1024 / 1024} MB`, 413);
  }

  const type = detectSheetType(input.bytes);
  if (!type.ok) throw new UploadError(type.reason, 415);

  const defaultCurrency = (input.defaultCurrency ?? "EUR").trim().toUpperCase();
  if (!CURRENCY_CODES.has(defaultCurrency)) throw new UploadError(`Unknown currency "${input.defaultCurrency}"`);

  // Same file uploaded again while the first upload is still being processed (e.g. a double click):
  // hand back the import that's already running instead of starting a second one.
  // This check is only the fast path. The real guarantee is the unique index below
  const sheetHash = createHash("sha256").update(input.bytes).digest("hex");
  const running = await findActiveImport(db, sheetHash);
  if (running) return { import: running, alreadyRunning: true };

  const id = randomUUID();
  const sheetPath = `imports/${id}/${safeFileName(input.fileName)}`;
  await saveFile(sheetPath, input.bytes);

  try {
    // The import row and its job are saved in one transaction: there's never an import without a job,
    // or a job for an import that doesn't exist
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(imports)
        .values({ id, status: "queued", sheetFileName: input.fileName, sheetPath, sheetHash, defaultCurrency })
        .returning();
      await boss.send(queues.parseImport.name, { importId: id } satisfies ParseImportJob, {
        db: fromDrizzle(tx, sql),
        singletonKey: id,
      });
      return row;
    });
    return { import: created, alreadyRunning: false };
  } catch (err) {
    if (!isActiveFileConflict(err)) throw err;
    // Another upload of the same file got in between our check and our insert. Postgres refused ours,
    // so use theirs and remove the copy of the file we just saved
    await deleteStoredFolder(`imports/${id}`);
    const winner = await findActiveImport(db, sheetHash);
    if (!winner) throw err;
    return { import: winner, alreadyRunning: true };
  }
}
