import { z } from "zod";
import { getDb } from "@/server/db/client";
import { bulkApprove } from "@/server/products/review";
import { revalidateStorefront } from "@/server/storefront/revalidate";

const bodySchema = z.union([z.strictObject({ ids: z.array(z.uuid()).min(1).max(1000) }), z.strictObject({ importId: z.uuid() })]);

// POST /api/products/bulk-approve  { "ids": [...] }  or  { "importId": "..." } (every "ready" product of that import)
// Approves what can be approved and lists the rest with the reason (no price, deleted, not found)
export async function POST(request: Request) {
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'Send JSON: { "ids": ["..."] } (at most 1,000) or { "importId": "..." }' }, { status: 400 });
  const result = await bulkApprove(getDb(), body.data);
  // What shoppers see changed: the storefront shows it now instead of within a minute
  revalidateStorefront();
  return Response.json(result);
}
