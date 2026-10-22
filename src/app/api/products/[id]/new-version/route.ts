import { z } from "zod";
import { getDb } from "@/server/db/client";
import { applyNewVersion, keepCurrentListing, ProductActionError } from "@/server/products/review";
import { getApiBoss } from "@/server/queue/boss";
import { revalidateStorefront } from "@/server/storefront/revalidate";

const notFound = () => Response.json({ error: "Product not found" }, { status: 404 });

function failed(err: unknown) {
  if (err instanceof ProductActionError) return Response.json({ error: err.message }, { status: err.status });
  console.error("[api] new version action failed", err);
  return Response.json({ error: "Something went wrong. Try again" }, { status: 500 });
}

// POST /api/products/:id/new-version - "Use the new version": the listing the AI wrote for an approved product
// replaces the one in the shop. It stays approved, and its translations are made again. 409 when none is waiting
export async function POST(_request: Request, ctx: RouteContext<"/api/products/[id]/new-version">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();
  try {
    const result = await applyNewVersion(getDb(), await getApiBoss(), id);
    // What shoppers see changed: the storefront shows it now instead of within a minute
    revalidateStorefront();
    return Response.json(result);
  } catch (err) {
    return failed(err);
  }
}

// DELETE /api/products/:id/new-version - "Keep the current one": the waiting version is dropped, the shop is
// unchanged. The same sheet uploaded again doesn't bring it back
export async function DELETE(_request: Request, ctx: RouteContext<"/api/products/[id]/new-version">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();
  try {
    return Response.json(await keepCurrentListing(getDb(), id));
  } catch (err) {
    return failed(err);
  }
}
