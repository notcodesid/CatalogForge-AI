import { z } from "zod";
import { getDb } from "@/server/db/client";
import { ProductActionError, sendBack } from "@/server/products/review";
import { revalidateStorefront } from "@/server/storefront/revalidate";

const bodySchema = z.object({ reason: z.string().trim().min(1, "Say why it's sent back").max(500) });

// POST /api/products/:id/send-back  { "reason": "The photo shows the wrong colour" }
// Back to "needs review" (and out of the storefront), with the merchant's reason shown first
export async function POST(request: Request, ctx: RouteContext<"/api/products/[id]/send-back">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Product not found" }, { status: 404 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'Send JSON: { "reason": "why it needs another look" }' }, { status: 400 });
  try {
    const result = await sendBack(getDb(), id, body.data.reason);
    // What shoppers see changed: the storefront shows it now instead of within a minute
    revalidateStorefront();
    return Response.json(result);
  } catch (err) {
    if (err instanceof ProductActionError) return Response.json({ error: err.message }, { status: err.status });
    console.error("[api] sending a product back failed", err);
    return Response.json({ error: "Something went wrong. Try again" }, { status: 500 });
  }
}
