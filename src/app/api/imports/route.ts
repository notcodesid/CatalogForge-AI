import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { createImport, MAX_SHEET_BYTES, UploadError } from "@/server/imports/create-import";
import { listImports } from "@/server/imports/list";
import { MAX_PHOTO_REQUEST_BYTES, type UploadedFile } from "@/server/photos/upload";
import { getApiBoss } from "@/server/queue/boss";
import { wakeWorkerAfter, wakeWorkerIfIdle } from "@/worker/wake";

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/imports?limit=20&offset=0 - the upload queue, newest first, with each import's live counts: phase,
// rows by status, products new or already in the catalog, photos, translation progress per language, pause and error
export async function GET(request: Request) {
  await connection();
  const query = listSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: z.prettifyError(query.error) }, { status: 400 });
  // The Upload tab polls this: a good moment to notice work waiting with no worker
  wakeWorkerIfIdle(request);
  return Response.json(await listImports(getDb(), query.data));
}

// POST /api/imports (multipart form)
//   sheet           the CSV/XLSX file
//   photos          optional, any number: photos (JPEG, PNG, WebP) or ZIPs of photos
//   waitForPhotos   optional "true": more photos follow (POST /api/imports/:id/photos), then POST /api/imports/:id/start
//   defaultCurrency optional
// Saves the files, queues the work and answers straight away with the import id
export async function POST(request: Request) {
  // Refuse oversized uploads before reading the body
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_SHEET_BYTES + MAX_PHOTO_REQUEST_BYTES) {
    return Response.json(
      { error: `The upload is too big. Send at most ${MAX_PHOTO_REQUEST_BYTES / 1024 / 1024} MB of photos per request, and the rest with POST /api/imports/:id/photos` },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Send the file as multipart/form-data in a field called "sheet"' }, { status: 400 });
  }

  const file = form.get("sheet");
  if (!(file instanceof File)) {
    return Response.json({ error: 'No file found. Send it in a field called "sheet"' }, { status: 400 });
  }
  const currency = form.get("defaultCurrency");
  const photos: UploadedFile[] = [];
  for (const photo of form.getAll("photos")) {
    if (photo instanceof File) photos.push({ name: photo.name, bytes: new Uint8Array(await photo.arrayBuffer()) });
  }

  try {
    const result = await createImport(getDb(), await getApiBoss(), {
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      defaultCurrency: typeof currency === "string" && currency ? currency : undefined,
      photos,
      waitForPhotos: form.get("waitForPhotos") === "true",
    });
    wakeWorkerAfter(request);
    return Response.json(
      {
        id: result.import.id,
        status: result.import.status,
        alreadyRunning: result.alreadyRunning,
        photos: result.photos,
        statusUrl: `/api/imports/${result.import.id}`,
      },
      { status: result.alreadyRunning ? 200 : 202 },
    );
  } catch (err) {
    if (err instanceof UploadError) return Response.json({ error: err.message }, { status: err.status });
    console.error("[api] upload failed", err);
    return Response.json({ error: "Something went wrong saving the upload. Try again" }, { status: 500 });
  }
}
