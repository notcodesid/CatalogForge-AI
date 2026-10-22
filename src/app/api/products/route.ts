import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { listProducts, productListQuery } from "@/server/products/list";

// GET /api/products?page=1&pageSize=25&sort=confidence&order=asc&search=planter&status=needs_review&category=Home%20%26%20Garden&importId=...&maxConfidence=69&deleted=true
// The Products tab: one page of products, sorted, searched and filtered. Deleted products only with deleted=true
export async function GET(request: Request) {
  await connection();
  const query = productListQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: z.prettifyError(query.error) }, { status: 400 });
  return Response.json(await listProducts(getDb(), query.data));
}
