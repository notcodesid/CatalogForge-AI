import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { after } from "next/server";
import { getDb } from "@/server/db/client";
import { env } from "@/server/env";
import { getApiBoss } from "@/server/queue/boss";
import { queues } from "@/server/queue/queues";

// Starting worker bursts on a host with no always-on machine (see serverless.ts), kept apart from the worker itself
// so the routes that queue work don't carry the whole worker

// Two at most: the one finishing and the next one it started
const MAX_BURSTS = 2;

// Jobs not finished yet, including ones that start later (a retry after its wait, a batch moved past a rate-limit
// pause). The watchdog's own job comes back every minute, so it doesn't count
export async function jobsLeft(): Promise<number> {
  const names = Object.values(queues)
    .map((q) => q.name)
    .filter((n) => n !== queues.watchdog.name && n !== queues.ping.name);
  const { rows } = await getDb().execute<{ n: number }>(
    sql`select count(*)::int as n from pgboss.job where name = any(${sql.param(names)}::text[]) and state in ('created', 'retry', 'active')`,
  );
  return rows[0].n;
}

async function workersOnline(): Promise<number> {
  const instances = await (await getApiBoss()).getInstances();
  return instances.filter((i) => i.name === "worker" && i.live).length;
}

export const serverlessWorker = () => Boolean(env().WORKER_KEY);

export function isWorkerKey(key: string | null) {
  const want = Buffer.from(env().WORKER_KEY ?? "");
  const got = Buffer.from(key ?? "");
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

// May a new burst start? Not when two are already running
export async function burstWanted() {
  return (await workersOnline()) < MAX_BURSTS;
}

// Asks /api/worker for a burst. That route answers at once and runs the burst after its answer
export async function wakeWorker(origin: string) {
  if (!serverlessWorker()) return;
  try {
    await fetch(new URL("/api/worker", origin), { method: "POST", headers: { "x-worker-key": env().WORKER_KEY! }, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    console.error("[worker] couldn't start a burst:", err instanceof Error ? err.message : err);
  }
}

// For a route that just queued work: start a burst once the answer is sent
export function wakeWorkerAfter(request: Request) {
  if (!serverlessWorker()) return;
  const { origin } = new URL(request.url);
  after(() => wakeWorker(origin));
}

// The dashboard asks this while it polls an import: a burst whose function was cut off before it could start the
// next one leaves work waiting with no worker. Checked at most every 15 s per server instance
let lastCheck = 0;
export function wakeWorkerIfIdle(request: Request) {
  if (!serverlessWorker() || Date.now() - lastCheck < 15_000) return;
  lastCheck = Date.now();
  const { origin } = new URL(request.url);
  after(async () => {
    if ((await jobsLeft()) > 0 && (await workersOnline()) === 0) await wakeWorker(origin);
  });
}
