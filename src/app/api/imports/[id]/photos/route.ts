import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { photoStatus } from "@/server/db/schema";
import { addPhotos, UploadError } from "@/server/imports/create-import";
import { listImportPhotos } from "@/server/imports/queries";
import { MAX_PHOTO_REQUEST_BYTES, type UploadedFile } from "@/server/photos/upload";

const querySchema = z.object({
  status: z.enum(photoStatus.enumValues).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/imports/:id/photos?status=unmatched&limit=50&offset=0
// Every photo of the import: which product it went to and how, or why it's unmatched or rejected
export async function GET(request: Request, ctx: RouteContext<"/api/imports/[id]/photos">) {
  await connection();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Import not found" }, { status: 404 });

  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: z.prettifyError(query.error) }, { status: 400 });

  return Response.json(await listImportPhotos(getDb(), id, query.data));
}

// POST /api/imports/:id/photos (multipart form, field "photos": photos or ZIPs, as many as fit in one request)
// Adds photos to an import that's waiting for its files. Sending the same file again does nothing
export async function POST(request: Request, ctx: RouteContext<"/api/imports/[id]/photos">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Import not found" }, { status: 404 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_PHOTO_REQUEST_BYTES) {
    return Response.json({ error: `Too much in one request. Send at most ${MAX_PHOTO_REQUEST_BYTES / 1024 / 1024} MB at a time` }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Send the photos as multipart/form-data in a field called "photos"' }, { status: 400 });
  }
  const files: UploadedFile[] = [];
  for (const photo of form.getAll("photos")) {
    if (photo instanceof File) files.push({ name: photo.name, bytes: new Uint8Array(await photo.arrayBuffer()) });
  }
  if (!files.length) return Response.json({ error: 'No photos found. Send them in a field called "photos"' }, { status: 400 });

  try {
    return Response.json(await addPhotos(getDb(), id, files));
  } catch (err) {
    if (err instanceof UploadError) return Response.json({ error: err.message }, { status: err.status });
    console.error("[api] photo upload failed", err);
    return Response.json({ error: "Something went wrong saving the photos. Try again" }, { status: 500 });
  }
}
