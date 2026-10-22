import { z } from "zod";
import { getDb } from "@/server/db/client";
import { approveProduct, ProductActionError } from "@/server/products/review";
import { revalidateStorefront } from "@/server/storefront/revalidate";

// POST /api/products/:id/approve - puts the product in the storefront. Refused (409, with why) while a variant
// has no price, or the product is deleted
export async function POST(_request: Request, ctx: RouteContext<"/api/products/[id]/approve">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Product not found" }, { status: 404 });
  try {
    const result = await approveProduct(getDb(), id);
    // What shoppers see changed: the storefront shows it now instead of within a minute
    revalidateStorefront();
    return Response.json(result);
  } catch (err) {
    if (err instanceof ProductActionError) return Response.json({ error: err.message }, { status: err.status });
    console.error("[api] approving a product failed", err);
    return Response.json({ error: "Something went wrong. Try again" }, { status: 500 });
  }
}
