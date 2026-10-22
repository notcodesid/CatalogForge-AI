import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { listImportProducts } from "@/server/imports/queries";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/imports/:id/products?limit=50&offset=0
// The products this import wrote: title, category, claims with their sources, confidence, variants, and why
// a product needs review
export async function GET(request: Request, ctx: RouteContext<"/api/imports/[id]/products">) {
  await connection();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Import not found" }, { status: 404 });

  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: z.prettifyError(query.error) }, { status: 400 });

  return Response.json(await listImportProducts(getDb(), id, query.data));
}
