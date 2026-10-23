import { after } from "next/server";
import { runWorkerBurst } from "@/worker/serverless";
import { burstWanted, isWorkerKey, serverlessWorker } from "@/worker/wake";

// A burst runs up to the free plan's limit
export const maxDuration = 300;

// POST /api/worker: start a worker burst (see worker/serverless.ts). Only with WORKER_KEY set, and only for callers
// that send it (the app itself)
export async function POST(request: Request) {
  if (!serverlessWorker()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!isWorkerKey(request.headers.get("x-worker-key"))) return Response.json({ error: "Not allowed" }, { status: 401 });
  if (!(await burstWanted())) return Response.json({ started: false, reason: "Two bursts are already running" });
  const { origin } = new URL(request.url);
  after(() => runWorkerBurst(origin).catch((err: unknown) => console.error("[worker] burst failed", err)));
  return Response.json({ started: true }, { status: 202 });
}
