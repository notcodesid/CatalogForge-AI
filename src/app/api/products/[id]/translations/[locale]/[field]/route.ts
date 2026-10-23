import { z } from "zod";
import { getDb } from "@/server/db/client";
import { getApiBoss } from "@/server/queue/boss";
import { confirmTranslation, revertToAi, TranslationEditError, writeTranslation } from "@/server/translations/merchant";
import { revalidateStorefront } from "@/server/storefront/revalidate";
import { wakeWorkerAfter } from "@/worker/wake";

const bodySchema = z.union([z.object({ confirm: z.literal(true) }), z.object({ value: z.unknown() })]);

function failed(err: unknown) {
  if (err instanceof TranslationEditError) return Response.json({ error: err.message }, { status: err.status });
  console.error("[api] changing a translation failed", err);
  return Response.json({ error: "Something went wrong. Try again" }, { status: 500 });
}

// PUT /api/products/:id/translations/:locale/:field
//   { "value": ... }      the merchant's own translation. It always wins, and is kept when the English changes
//                         (shown as out of date). Our checks come back as warnings
//   { "confirm": true }   the English changed, but the merchant's translation is still right
export async function PUT(request: Request, ctx: RouteContext<"/api/products/[id]/translations/[locale]/[field]">) {
  const { id, locale, field } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Product not found" }, { status: 404 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success || ("value" in body.data && body.data.value === undefined)) {
    return Response.json({ error: 'Send JSON: { "value": ... } or { "confirm": true }' }, { status: 400 });
  }
  try {
    const db = getDb();
    const result = "confirm" in body.data ? await confirmTranslation(db, id, locale, field) : await writeTranslation(db, id, locale, field, body.data.value);
    // What shoppers see changed: the storefront shows it now instead of within a minute
    revalidateStorefront();
    return Response.json(result);
  } catch (err) {
    return failed(err);
  }
}

// DELETE /api/products/:id/translations/:locale/:field - drops the merchant's own translation; the AI translates
// the field again
export async function DELETE(request: Request, ctx: RouteContext<"/api/products/[id]/translations/[locale]/[field]">) {
  const { id, locale, field } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Product not found" }, { status: 404 });
  try {
    const result = await revertToAi(getDb(), await getApiBoss(), id, locale, field);
    wakeWorkerAfter(request);
    // What shoppers see changed: the storefront shows it now instead of within a minute
    revalidateStorefront();
    return Response.json(result);
  } catch (err) {
    return failed(err);
  }
}
