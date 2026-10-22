import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { productDetail } from "@/server/products/detail";
import { deleteProduct, editProduct, ProductActionError, productEdit } from "@/server/products/review";
import { getApiBoss } from "@/server/queue/boss";
import { revalidateStorefront } from "@/server/storefront/revalidate";

const notFound = () => Response.json({ error: "Product not found" }, { status: 404 });

function failed(err: unknown) {
  if (err instanceof ProductActionError) return Response.json({ error: err.message }, { status: err.status });
  console.error("[api] product action failed", err);
  return Response.json({ error: "Something went wrong. Try again" }, { status: 500 });
}

// GET /api/products/:id - everything for the review screen: the AI's listing with its confidence per field and
// the source of every claim, next to the supplier's rows, the text it was written from, and the photos
export async function GET(_request: Request, ctx: RouteContext<"/api/products/[id]">) {
  await connection();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();
  try {
    const product = await productDetail(getDb(), id);
    return product ? Response.json(product) : notFound();
  } catch (err) {
    // Logged with its stack, and the review screen gets a message instead of an empty 500
    return failed(err);
  }
}

// PATCH /api/products/:id  { "title"?, "descriptionHtml"?, "category"?, "tags"?, "attributes"?, "prices"?: { [sku]: "21.50" } }
// The merchant's own edits. The AI never overwrites them, a re-upload never changes their prices; only the changed
// fields are translated again
export async function PATCH(request: Request, ctx: RouteContext<"/api/products/[id]">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();
  const body = productEdit.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });
  try {
    const result = await editProduct(getDb(), await getApiBoss(), id, body.data);
    // What shoppers see changed: the storefront shows it now instead of within a minute
    revalidateStorefront();
    return Response.json(result);
  } catch (err) {
    return failed(err);
  }
}

// DELETE /api/products/:id - out of the storefront and exports at once; kept so it can be restored, and so a
// re-upload doesn't bring it back silently
export async function DELETE(_request: Request, ctx: RouteContext<"/api/products/[id]">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();
  try {
    const result = await deleteProduct(getDb(), id);
    // What shoppers see changed: the storefront shows it now instead of within a minute
    revalidateStorefront();
    return Response.json(result);
  } catch (err) {
    return failed(err);
  }
}
