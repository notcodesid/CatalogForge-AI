import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { getImportSummary } from "@/server/imports/queries";
import { wakeWorkerIfIdle } from "@/worker/wake";

// GET /api/imports/:id - status, stage and row counts (done / needs review / failed / pending), and how many of its
// products were new or already in the catalog (updated), with the earlier files those came from once it's done
export async function GET(request: Request, ctx: RouteContext<"/api/imports/[id]">) {
  await connection();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Import not found" }, { status: 404 });

  const summary = await getImportSummary(getDb(), id);
  if (!summary) return Response.json({ error: "Import not found" }, { status: 404 });
  wakeWorkerIfIdle(request);
  return Response.json(summary);
}
