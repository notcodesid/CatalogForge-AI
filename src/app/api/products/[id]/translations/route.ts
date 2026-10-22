import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { productTranslations, TranslationEditError } from "@/server/translations/merchant";

// GET /api/products/:id/translations
// The English, and per language: each field's translation (by the AI or the merchant, its problem, out of date
// or not), the translation's state, and what shoppers in that language see
export async function GET(_request: Request, ctx: RouteContext<"/api/products/[id]/translations">) {
  await connection();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Product not found" }, { status: 404 });
  try {
    return Response.json(await productTranslations(getDb(), id));
  } catch (err) {
    if (err instanceof TranslationEditError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
