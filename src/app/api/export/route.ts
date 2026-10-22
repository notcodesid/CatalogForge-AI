import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { exportCatalog, exportOptionsSchema } from "@/server/export";

// GET /api/export?format=csv|json|shopify&status=approved|ready|all&language=en|de|fr[&vendor=...]
// Downloads the catalog: CSV (one row per variant), JSON (the brief's product format, with photos and every shop
// language) or Shopify's product CSV. Defaults: csv, approved products, English. Streamed a page at a time
export async function GET(request: Request) {
  await connection();
  const url = new URL(request.url);
  const query = exportOptionsSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return Response.json({ error: z.prettifyError(query.error) }, { status: 400 });

  let file;
  try {
    file = await exportCatalog(getDb(), { ...query.data, origin: url.origin });
  } catch (err) {
    console.error("[api] export failed", err);
    return Response.json({ error: "Something went wrong preparing the export. Try again" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const chunks = file.chunks[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (err) {
        // The download has started, so the status can't change any more: the file ends early instead
        console.error("[api] export failed part-way", err);
        controller.error(err);
      }
    },
    async cancel() {
      await chunks.return?.(undefined);
    },
  });

  return new Response(body, {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "no-store",
    },
  });
}
