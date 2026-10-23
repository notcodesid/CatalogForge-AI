import { z } from "zod";
import { getDb } from "@/server/db/client";
import { retryImport, RetryError } from "@/server/imports/retry";
import { getApiBoss } from "@/server/queue/boss";
import { wakeWorkerAfter } from "@/worker/wake";

// POST /api/imports/:id/retry - tries the import's failed rows again (new AI batches) and its failed
// translations. Rows that failed while the sheet was read stay failed: fix the sheet and upload it again
export async function POST(request: Request, ctx: RouteContext<"/api/imports/[id]/retry">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Import not found" }, { status: 404 });
  try {
    const result = await retryImport(getDb(), await getApiBoss(), id);
    wakeWorkerAfter(request);
    return Response.json(result);
  } catch (err) {
    if (err instanceof RetryError) return Response.json({ error: err.message }, { status: err.status });
    console.error("[api] retry failed", err);
    return Response.json({ error: "Something went wrong. Try again" }, { status: 500 });
  }
}
