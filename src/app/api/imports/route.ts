import { getDb } from "@/server/db/client";
import { createImport, MAX_SHEET_BYTES, UploadError } from "@/server/imports/create-import";
import { getApiBoss } from "@/server/queue/boss";

// POST /api/imports (multipart form: "sheet" = the CSV/XLSX file, optional "defaultCurrency")
// Saves the file, queues the work and answers straight away with the import id
export async function POST(request: Request) {
  // Refuse oversized uploads before reading the body
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_SHEET_BYTES + 1024 * 1024) {
    return Response.json({ error: `The file is too big. The limit is ${MAX_SHEET_BYTES / 1024 / 1024} MB` }, { status: 413 });
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

  try {
    const result = await createImport(getDb(), await getApiBoss(), {
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      defaultCurrency: typeof currency === "string" && currency ? currency : undefined,
    });
    return Response.json(
      {
        id: result.import.id,
        status: result.import.status,
        alreadyRunning: result.alreadyRunning,
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
