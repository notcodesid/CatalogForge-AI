import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { Db } from "@/server/db/client";
import { imports } from "@/server/db/schema";
import { CURRENCY_CODES } from "@/server/pipeline/clean/price";
import { detectSheetType } from "@/server/pipeline/detect-file-type";
import { queues, type ParseImportJob } from "@/server/queue/queues";
import { MAX_PHOTOS_PER_IMPORT, savePhotos, unpackPhotos, type UploadedFile } from "@/server/photos/upload";
import { enqueuePhotoJobs } from "@/server/photos/process";
import { deleteStoredFolder, saveFile } from "@/server/storage";
import { UploadError } from "./upload-error";

export const MAX_SHEET_BYTES = 25 * 1024 * 1024;

const ACTIVE_STATUSES = ["queued", "running", "paused"] as const;

export { UploadError };

export type NewImport = {
  fileName: string;
  bytes: Uint8Array;
  defaultCurrency?: string;
  // Photos and ZIPs of photos sent with the sheet
  photos?: UploadedFile[];
  // More photos will follow (POST /api/imports/:id/photos): keep the import waiting until it's started
  waitForPhotos?: boolean;
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
  const withPhotos = Boolean(input.photos?.length) || Boolean(input.waitForPhotos);
  if (running && withPhotos) {
    throw new UploadError("This sheet is already being imported. Wait until it's done, then upload it again with its photos", 409);
  }
  if (running) return { import: running, alreadyRunning: true };

  // Checked before anything is saved, so a refused upload leaves nothing behind
  const unpacked = withPhotos ? await unpackPhotos(input.photos ?? []) : null;
  if (unpacked && unpacked.accepted.length > MAX_PHOTOS_PER_IMPORT) {
    throw new UploadError(`An import can have at most ${MAX_PHOTOS_PER_IMPORT.toLocaleString("en")} photos. This upload has ${unpacked.accepted.length.toLocaleString("en")}`, 413);
  }

  const id = randomUUID();
  const sheetPath = `imports/${id}/${safeFileName(input.fileName)}`;
  await saveFile(sheetPath, input.bytes);

  // With photos: the import waits for its files, then starts (right away, unless more photos are coming)
  if (unpacked) {
    await db.insert(imports).values({ id, status: "waiting_for_files", sheetFileName: input.fileName, sheetPath, sheetHash, defaultCurrency });
    const photoResult = await savePhotos(db, id, unpacked);
    const started = input.waitForPhotos ? null : await startImport(db, boss, id);
    const [row] = started ? [started] : await db.select().from(imports).where(eq(imports.id, id));
    return { import: row, alreadyRunning: false, photos: photoResult };
  }

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

// More photos for an import that's waiting for its files (big photo sets arrive in several requests)
export async function addPhotos(db: Db, importId: string, files: UploadedFile[]) {
  const [imp] = await db.select({ status: imports.status }).from(imports).where(eq(imports.id, importId));
  if (!imp) throw new UploadError("Import not found", 404);
  if (imp.status !== "waiting_for_files") {
    throw new UploadError("This import has already started. Photos can only be added before it starts", 409);
  }
  return savePhotos(db, importId, await unpackPhotos(files));
}

// Starts an import that was waiting for its photos: queues the parse job and the photo batches in one
// transaction, so neither can go missing. Starting it twice does nothing the second time
export async function startImport(db: Db, boss: PgBoss, importId: string) {
  try {
    return await db.transaction(async (tx) => {
      const [imp] = await tx.select().from(imports).where(eq(imports.id, importId)).for("update");
      if (!imp) throw new UploadError("Import not found", 404);
      if (imp.status !== "waiting_for_files") return imp;
      const [row] = await tx.update(imports).set({ status: "queued" }).where(eq(imports.id, importId)).returning();
      await boss.send(queues.parseImport.name, { importId } satisfies ParseImportJob, { db: fromDrizzle(tx, sql), singletonKey: importId });
      await enqueuePhotoJobs(tx, boss, importId);
      return row;
    });
  } catch (err) {
    if (!isActiveFileConflict(err)) throw err;
    throw new UploadError("The same sheet is already being imported. Wait until it's done, then start this one again", 409);
  }
}
