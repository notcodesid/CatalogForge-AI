import { z } from "zod";
import { getDb } from "@/server/db/client";
import { getApiBoss } from "@/server/queue/boss";
import { retryFailed } from "@/server/translations/state";

const bodySchema = z.object({ productIds: z.array(z.uuid()).max(1000).optional() }).default({});

// POST /api/translations/retry  { "productIds": [...] } (optional) - tries failed translations again
export async function POST(request: Request) {
  const body = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: 'Send JSON: {} or { "productIds": ["..."] }' }, { status: 400 });
  const batches = await retryFailed(getDb(), await getApiBoss(), body.data);
  return Response.json({ queuedBatches: batches });
}
