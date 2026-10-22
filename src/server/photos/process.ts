import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import sharp from "sharp";
import type { Db } from "@/server/db/client";
import { photos } from "@/server/db/schema";
import { finishImportIfComplete } from "@/server/pipeline/build";
import { queues, type ProcessPhotosJob } from "@/server/queue/queues";
import { deleteStoredFile, readStoredFile, saveFile } from "@/server/storage";
import { downloadPhoto } from "./download";
import { fileKind } from "./upload";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const PHOTO_BATCH_SIZE = 50;
const LARGE_PX = 1600;
const THUMB_PX = 400;
// A photo bigger than this (e.g. 20,000 x 20,000) is almost certainly a mistake, and would use gigabytes of memory
const MAX_PIXELS = 100_000_000;
// Photos of one batch handled at the same time
const PARALLEL_PHOTOS = 4;

// Photos of an import that still have to be processed, queued in batches. Called when the import starts and
// when the sheet's photo links are found (inside the same transaction, so they're never lost), and by the
// watchdog when a batch went missing
// (only the given photos, when photoIds is passed)
export async function enqueuePhotoJobs(tx: Tx, boss: PgBoss, importId: string, photoIds?: string[]) {
  const waiting = await tx
    .select({ id: photos.id })
    .from(photos)
    .where(
      and(
        eq(photos.importId, importId),
        isNull(photos.processedAt),
        ne(photos.status, "rejected"),
        photoIds ? inArray(photos.id, photoIds) : undefined,
      ),
    )
    .orderBy(asc(photos.fileName));
  const jobs = [];
  for (let i = 0; i < waiting.length; i += PHOTO_BATCH_SIZE) {
    const photoIds = waiting.slice(i, i + PHOTO_BATCH_SIZE).map((p) => p.id);
    const key = createHash("sha256").update(photoIds.join("\n")).digest("hex").slice(0, 16);
    jobs.push({ data: { importId, photoIds } satisfies ProcessPhotosJob, singletonKey: `${importId}:photos:${key}` });
  }
  if (jobs.length) await boss.insert(queues.processPhotos.name, jobs, { db: fromDrizzle(tx, sql) });
  return jobs.length;
}

type Processed =
  | { ok: true; contentHash: string; storagePath: string; thumbnailPath: string; width: number; height: number }
  | { ok: false; reason: string };

type Download = (link: string) => Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }>;

const stored = {
  storagePath: photos.storagePath,
  thumbnailPath: photos.thumbnailPath,
  width: photos.width,
  height: photos.height,
  contentHash: photos.contentHash,
};

// The bytes of a photo: the upload, or the download of the sheet's link. Or the reason there are none
async function photoBytes(photo: { originalPath: string | null; sourceUrl: string | null }, download: Download) {
  if (photo.sourceUrl && !photo.originalPath) {
    const result = await download(photo.sourceUrl);
    if (!result.ok) return { reason: `Couldn't download the photo: ${result.reason}` };
    // Checked like an upload: a link to a web page or a PDF isn't a photo
    const kind = fileKind(result.bytes);
    if (kind === "heic") return { reason: "The link leads to a HEIC photo, which isn't supported. Use JPEG, PNG or WebP" };
    if (kind !== "jpeg" && kind !== "png" && kind !== "webp") return { reason: "The link doesn't lead to a photo (JPEG, PNG or WebP)" };
    return { bytes: result.bytes };
  }
  try {
    if (!photo.originalPath) throw new Error("no file");
    return { bytes: await readStoredFile(photo.originalPath) };
  } catch {
    return { reason: "The upload of this photo didn't finish. Upload it again" };
  }
}

async function processOne(db: Db, photo: { originalPath: string | null; sourceUrl: string | null }, download: Download): Promise<Processed> {
  // A link downloaded before (the same sheet uploaded again): use that copy instead of downloading it again
  if (photo.sourceUrl) {
    const [e] = await db.select(stored).from(photos).where(and(eq(photos.sourceUrl, photo.sourceUrl), isNotNull(photos.storagePath))).limit(1);
    if (e?.storagePath && e.thumbnailPath && e.width && e.height && e.contentHash) {
      return { ok: true, contentHash: e.contentHash, storagePath: e.storagePath, thumbnailPath: e.thumbnailPath, width: e.width, height: e.height };
    }
  }
  const source = await photoBytes(photo, download);
  if (!source.bytes) return { ok: false, reason: source.reason };
  const bytes = source.bytes;

  // The same picture was processed before (in this import or an earlier one): use that copy
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const [same] = await db
    .select({ storagePath: photos.storagePath, thumbnailPath: photos.thumbnailPath, width: photos.width, height: photos.height })
    .from(photos)
    .where(and(eq(photos.contentHash, contentHash), isNotNull(photos.storagePath)))
    .limit(1);
  if (same?.storagePath && same.thumbnailPath && same.width && same.height) {
    return { ok: true, contentHash, storagePath: same.storagePath, thumbnailPath: same.thumbnailPath, width: same.width, height: same.height };
  }

  try {
    // rotate() with no angle turns the photo the way the camera meant it (EXIF). Sharp drops all metadata
    // (camera, GPS location) unless asked to keep it
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate();
    const large = await image
      .clone()
      .resize({ width: LARGE_PX, height: LARGE_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const thumb = await image
      .clone()
      .resize({ width: THUMB_PX, height: THUMB_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
    // Named after the content: the same picture is only ever stored once
    const storagePath = `photos/${contentHash}.webp`;
    const thumbnailPath = `photos/${contentHash}-thumb.webp`;
    await saveFile(storagePath, large.data);
    await saveFile(thumbnailPath, thumb);
    return { ok: true, contentHash, storagePath, thumbnailPath, width: large.info.width, height: large.info.height };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/pixel limit/i.test(message)) return { ok: false, reason: "The photo is too large (over 100 megapixels)" };
    return { ok: false, reason: "This file can't be read as a photo. It may be damaged" };
  }
}

// Processes one batch of photos, a few at a time (downloads spend most of their time waiting for the other
// website). A photo that's already done is skipped, so running a batch again after a crash does no harm
export async function processPhotoBatch(
  db: Db,
  job: ProcessPhotosJob,
  options: { signal?: AbortSignal; download?: Download } = {},
) {
  const download = options.download ?? ((link: string) => downloadPhoto(link));
  const waiting = await db
    .select({ id: photos.id, originalPath: photos.originalPath, sourceUrl: photos.sourceUrl })
    .from(photos)
    .where(and(inArray(photos.id, job.photoIds), isNull(photos.processedAt), ne(photos.status, "rejected")));

  const handle = async (photo: (typeof waiting)[number]) => {
    const result = await processOne(db, photo, download);
    const done = { processedAt: new Date(), originalPath: null };
    await db
      .update(photos)
      .set(
        result.ok
          ? { ...done, contentHash: result.contentHash, storagePath: result.storagePath, thumbnailPath: result.thumbnailPath, width: result.width, height: result.height }
          : { ...done, status: "rejected", reason: result.reason },
      )
      .where(and(eq(photos.id, photo.id), isNull(photos.processedAt)));
    // The processed copy is what we keep. The original upload isn't needed any more
    if (photo.originalPath) await deleteStoredFile(photo.originalPath);
  };
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_PHOTOS, waiting.length) }, async () => {
      for (let photo = waiting.shift(); photo; photo = waiting.shift()) {
        options.signal?.throwIfAborted();
        await handle(photo);
      }
    }),
  );
  await finishImportIfComplete(db, job.importId);
}

// A batch that failed every try: its photos are marked Rejected with a reason, so the import can still finish
export async function rejectPhotoBatch(db: Db, job: ProcessPhotosJob) {
  await db
    .update(photos)
    .set({ status: "rejected", reason: "This photo couldn't be processed after several tries", processedAt: new Date() })
    .where(and(inArray(photos.id, job.photoIds), isNull(photos.processedAt)));
  await finishImportIfComplete(db, job.importId);
}
