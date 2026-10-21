import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { Db } from "@/server/db/client";
import { imports } from "@/server/db/schema";
import { queues, type ParseImportJob } from "@/server/queue/queues";

// How many times the watchdog restarts an import before giving up on it
export const MAX_RECOVERIES = 3;
// Don't touch imports that changed in the last 2 minutes: they're probably just between two steps
const QUIET_FOR = sql`interval '2 minutes'`;

const LIVE_JOB_STATES = new Set(["created", "retry", "active"]);

export type WatchdogResult = { restarted: string[]; failed: string[] };

// Safety net that runs every minute. An import that says "queued" or "running" must always have a job
// behind it. If the job has gone missing (deleted, lost, or the import was left behind for any other
// reason), the import would wait forever. Restart it (every step can safely run again), and after
// MAX_RECOVERIES restarts, fail it with a clear message instead of letting it spin forever
export async function recoverStalledImports(db: Db, boss: PgBoss): Promise<WatchdogResult> {
  const candidates = await db
    .select({ id: imports.id, recoveries: imports.recoveries })
    .from(imports)
    .where(
      and(
        inArray(imports.status, ["queued", "running"]),
        // Only the reading/cleaning stages for now. The AI and translation stages get their own checks when built
        or(isNull(imports.stage), inArray(imports.stage, ["parse", "clean", "group"])),
        lt(imports.updatedAt, sql`now() - ${QUIET_FOR}`),
      ),
    );

  const result: WatchdogResult = { restarted: [], failed: [] };
  for (const candidate of candidates) {
    const jobs = await boss.findJobs(queues.parseImport.name, { key: candidate.id });
    if (jobs.some((job) => LIVE_JOB_STATES.has(job.state))) continue;

    if (candidate.recoveries >= MAX_RECOVERIES) {
      await db
        .update(imports)
        .set({
          status: "failed",
          error: `The import stopped unexpectedly ${MAX_RECOVERIES + 1} times. Upload the file again`,
          finishedAt: new Date(),
        })
        .where(eq(imports.id, candidate.id));
      result.failed.push(candidate.id);
      continue;
    }

    // Count the restart and queue the job together, so we never count one without the other
    await db.transaction(async (tx) => {
      await tx
        .update(imports)
        .set({ status: "queued", recoveries: sql`${imports.recoveries} + 1` })
        .where(eq(imports.id, candidate.id));
      await boss.send(queues.parseImport.name, { importId: candidate.id } satisfies ParseImportJob, {
        db: fromDrizzle(tx, sql),
        singletonKey: candidate.id,
      });
    });
    result.restarted.push(candidate.id);
  }
  return result;
}
