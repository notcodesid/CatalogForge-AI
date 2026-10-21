import { PgBoss, type UpdateQueueOptions } from "pg-boss";
import { DB_TIMEOUTS } from "@/server/db/client";
import { env } from "@/server/env";
import { queues } from "./queues";

type Role = "api" | "worker";

export async function startBoss(role: Role, options: { connectionString?: string } = {}): Promise<PgBoss> {
  const isWorker = role === "worker";
  const boss = new PgBoss({
    connectionString: options.connectionString ?? env().DATABASE_URL,
    application_name: `catalogforge-${role}`,
    instanceName: role,
    // Same rule as our own connections: an abandoned transaction is cancelled after 60s
    options: `-c idle_in_transaction_session_timeout=${DB_TIMEOUTS.idleInTransactionMs}`,
    connectionTimeoutMillis: 10_000,
    // Only the worker runs maintenance (retrying jobs whose worker died, cleanup). The API only sends jobs
    supervise: isWorker,
    schedule: isWorker,
    // Look for jobs whose worker went quiet every 10s instead of every 60s, so a crashed import is picked up
    // again within ~25s (15s heartbeat + up to 10s until the next check)
    monitorIntervalSeconds: 10,
    superviseIntervalSeconds: 10,
    // Check in every 10s, so the health check sees a dead worker as offline after ~30s (3 missed check-ins)
    instanceHeartbeatSeconds: 10,
    max: isWorker ? 10 : 3,
  });
  boss.on("error", (err) => console.error(`[pg-boss:${role}]`, err));

  await boss.start();
  if (isWorker) await syncQueues(boss);
  else await createMissingQueues(boss);
  return boss;
}

async function createMissingQueues(boss: PgBoss) {
  // createQueue leaves an existing queue untouched, so this is safe on every start
  for (const queue of Object.values(queues)) await boss.createQueue(queue.name, queue.options);
}

// pg-boss saves a queue's settings only when the queue is first created. Without this, changing a retry
// limit in queues.ts would never reach a database where the queue already exists
export async function syncQueues(boss: PgBoss) {
  for (const queue of Object.values(queues)) {
    const existing = await boss.getQueue(queue.name);
    if (!existing) {
      await boss.createQueue(queue.name, queue.options);
      continue;
    }

    const wantedPolicy = "policy" in queue.options ? queue.options.policy : "standard";
    if (existing.policy !== wantedPolicy) {
      // The policy can't be changed in place, so the queue is rebuilt. Only when nothing is waiting or
      // running in it, otherwise we'd throw away real work
      const { rows } = await boss
        .getDb()
        .executeSql(`select count(*)::int as n from pgboss.job where name = $1 and state <= 'active'`, [queue.name]);
      const pending = (rows[0] as { n: number }).n;
      if (pending > 0) {
        console.warn(`[pg-boss] queue ${queue.name} should be "${wantedPolicy}" but has ${pending} unfinished jobs, leaving it as "${existing.policy}"`);
      } else {
        console.log(`[pg-boss] rebuilding queue ${queue.name}: "${existing.policy}" -> "${wantedPolicy}"`);
        await boss.deleteQueue(queue.name);
        await boss.createQueue(queue.name, queue.options);
        continue;
      }
    }

    // Everything except the policy (and partitioning) can be updated in place
    const settings: Record<string, unknown> = { ...queue.options };
    delete settings.policy;
    delete settings.partition;
    await boss.updateQueue(queue.name, settings as UpdateQueueOptions);
  }
}

// The API keeps one pg-boss per process (kept on globalThis because Next.js dev reloads modules)
const globalForBoss = globalThis as unknown as { apiBoss?: Promise<PgBoss> };

export function getApiBoss(): Promise<PgBoss> {
  globalForBoss.apiBoss ??= startBoss("api").catch((err: unknown) => {
    // Don't cache a failed start, try again on the next request
    globalForBoss.apiBoss = undefined;
    throw err;
  });
  return globalForBoss.apiBoss;
}
