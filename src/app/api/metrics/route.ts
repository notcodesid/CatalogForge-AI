import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { getMetrics } from "@/server/metrics/metrics";
import { metricsWindow, windowQuery } from "@/server/metrics/window";

// GET /api/metrics?days=7  or  ?from=2026-10-01&to=2026-10-22
// The Metrics tab: products processed and how they ended, imports and their speed, AI calls, tokens and cost
// (per model, per kind, per import, over time), call speed, problems, the money routing, batching and saved
// answers saved (estimates, explained in each "note"), and translation coverage per language
export async function GET(request: Request) {
  await connection();
  const query = windowQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: z.prettifyError(query.error) }, { status: 400 });
  const window = metricsWindow(query.data);
  if ("error" in window) return Response.json({ error: window.error }, { status: 400 });
  return Response.json(await getMetrics(getDb(), window));
}
