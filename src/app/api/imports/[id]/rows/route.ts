import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { rowStatus } from "@/server/db/schema";
import { listImportRows } from "@/server/imports/queries";

const querySchema = z.object({
  status: z.enum(rowStatus.enumValues).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/imports/:id/rows?status=failed&limit=50&offset=0
// Each row with what the sheet said, what we cleaned it to, and why it needs review or failed
export async function GET(request: Request, ctx: RouteContext<"/api/imports/[id]/rows">) {
  await connection();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Import not found" }, { status: 404 });

  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: z.prettifyError(query.error) }, { status: 400 });

  return Response.json(await listImportRows(getDb(), id, query.data));
}
