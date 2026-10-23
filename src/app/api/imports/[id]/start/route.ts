import { z } from "zod";
import { getDb } from "@/server/db/client";
import { startImport, UploadError } from "@/server/imports/create-import";
import { getApiBoss } from "@/server/queue/boss";
import { wakeWorkerAfter } from "@/worker/wake";

// POST /api/imports/:id/start - starts an import that was waiting for its photos. Safe to call twice
export async function POST(request: Request, ctx: RouteContext<"/api/imports/[id]/start">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Import not found" }, { status: 404 });
  try {
    const imp = await startImport(getDb(), await getApiBoss(), id);
    wakeWorkerAfter(request);
    return Response.json({ id: imp.id, status: imp.status, statusUrl: `/api/imports/${imp.id}` }, { status: 202 });
  } catch (err) {
    if (err instanceof UploadError) return Response.json({ error: err.message }, { status: err.status });
    console.error("[api] start failed", err);
    return Response.json({ error: "Something went wrong starting the import. Try again" }, { status: 500 });
  }
}
