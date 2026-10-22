import { z } from "zod";
import { getDb } from "@/server/db/client";
import { ProductActionError, restoreProduct } from "@/server/products/review";
import { getApiBoss } from "@/server/queue/boss";
import { revalidateStorefront } from "@/server/storefront/revalidate";

// POST /api/products/:id/restore - brings a deleted product back, with the status it had
export async function POST(_request: Request, ctx: RouteContext<"/api/products/[id]/restore">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Product not found" }, { status: 404 });
  try {
    const result = await restoreProduct(getDb(), await getApiBoss(), id);
    // What shoppers see changed: the storefront shows it now instead of within a minute
    revalidateStorefront();
    return Response.json(result);
  } catch (err) {
    if (err instanceof ProductActionError) return Response.json({ error: err.message }, { status: err.status });
    console.error("[api] restoring a product failed", err);
    return Response.json({ error: "Something went wrong. Try again" }, { status: 500 });
  }
}
