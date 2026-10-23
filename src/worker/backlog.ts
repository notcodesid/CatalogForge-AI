import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { env } from "@/server/env";
import { queues } from "@/server/queue/queues";

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

// Every minute, the number of jobs left as a CloudWatch metric (CatalogForge/QueueBacklog), for auto scaling the
// workers on AWS. Written as a log line in CloudWatch's embedded metric format: the container's logs go to
// CloudWatch, which turns the line into a metric, so the worker needs no extra permission or SDK. Only when
// METRICS_NAMESPACE is set
export function reportBacklog() {
  const namespace = env().METRICS_NAMESPACE;
  if (!namespace) return;
  const report = async () => {
    try {
      const backlog = await jobsLeft();
      console.log(
        JSON.stringify({
          _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [["Service"]], Metrics: [{ Name: "QueueBacklog", Unit: "Count" }] }] },
          Service: "worker",
          QueueBacklog: backlog,
        }),
      );
    } catch (err) {
      console.error("[worker] couldn't count the jobs left:", err instanceof Error ? err.message : err);
    }
  };
  void report();
  setInterval(() => void report(), 60_000).unref();
}
