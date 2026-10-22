import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { Db } from "@/server/db/client";
import { importRows, imports, photos, products, translationState } from "@/server/db/schema";
import { enqueuePhotoJobs } from "@/server/photos/process";
import { enqueuePendingTranslations } from "@/server/translations/state";
import { batchKey, finishImportIfComplete, groupByProduct, planBuildBatches } from "@/server/pipeline/build";
import { queues, type ParseImportJob } from "@/server/queue/queues";

// How many times the watchdog restarts an import before giving up on it
export const MAX_RECOVERIES = 3;
// Don't touch imports that changed in the last 2 minutes: they're probably just between two steps
const QUIET_FOR = sql`interval '2 minutes'`;

const LIVE_JOB_STATES = new Set(["created", "retry", "active"]);

export type WatchdogResult = { restarted: string[]; failed: string[] };

const stoppedMessage = `The import stopped unexpectedly ${MAX_RECOVERIES + 1} times. Upload the file again`;

// Safety net that runs every minute. An import that says "queued" or "running" must always have a job
// behind it. If the job has gone missing (deleted, lost, or the import was left behind for any other
// reason), the import would wait forever. Restart it (every step can safely run again), and after
// MAX_RECOVERIES restarts, fail it with a clear message instead of letting it spin forever
export async function recoverStalledImports(db: Db, boss: PgBoss): Promise<WatchdogResult> {
  const result: WatchdogResult = { restarted: [], failed: [] };
  await recoverParsing(db, boss, result);
  await recoverBuilding(db, boss, result);
  await recoverPhotos(db, boss, result);
  await recoverTranslations(db, boss, result);
  return result;
}

// Translations still to do, but no translation job queued or running for them (never queued, or their job
// went missing). Grouped like the jobs: per import, or "catalog" for products without one
async function recoverTranslations(db: Db, boss: PgBoss, result: WatchdogResult) {
  const { rows: scopes } = await db.execute<{ scope: string }>(sql`
    select distinct coalesce(p.last_import_id::text, 'catalog') as scope
    from ${translationState} ts join ${products} p on p.id = ts.product_id
    where ts.status = 'pending' and p.deleted_at is null and ts.updated_at < now() - ${QUIET_FOR}
  `);
  for (const { scope } of scopes) {
    const { rows } = await boss
      .getDb()
      .executeSql(`select count(*)::int as n from pgboss.job where name = $1 and state <= 'active' and data->>'scope' = $2`, [queues.translateBatch.name, scope]);
    if ((rows[0] as { n: number }).n > 0) continue;
    // Taken by a job that's gone: free them, then queue them again
    await db.execute(sql`
      update ${translationState} ts set queued_at = null
      from ${products} p
      where p.id = ts.product_id and ts.status = 'pending' and ts.queued_at is not null
        and ${scope === "catalog" ? sql`p.last_import_id is null` : sql`p.last_import_id = ${scope}`}
    `);
    const queued = await enqueuePendingTranslations(db, boss, scope === "catalog" ? { catalogOnly: true } : { importId: scope });
    if (queued && scope !== "catalog" && !result.restarted.includes(scope)) result.restarted.push(scope);
  }
}

// Photos still waiting to be processed, but no photo batch queued or running for them. Processing a photo
// twice is harmless, and a photo that keeps failing ends up Rejected (dead letter), so this can't loop forever
async function recoverPhotos(db: Db, boss: PgBoss, result: WatchdogResult) {
  const candidates = await db
    .selectDistinct({ id: photos.importId })
    .from(photos)
    .innerJoin(imports, eq(imports.id, photos.importId))
    .where(
      and(
        inArray(imports.status, ["queued", "running", "paused"]),
        isNull(photos.processedAt),
        ne(photos.status, "rejected"),
        lt(photos.updatedAt, sql`now() - ${QUIET_FOR}`),
      ),
    );

  for (const { id } of candidates) {
    const { rows } = await boss
      .getDb()
      .executeSql(`select count(*)::int as n from pgboss.job where name = $1 and state <= 'active' and data->>'importId' = $2`, [
        queues.processPhotos.name,
        id,
      ]);
    if ((rows[0] as { n: number }).n > 0) continue;
    await db.transaction((tx) => enqueuePhotoJobs(tx, boss, id));
    if (!result.restarted.includes(id)) result.restarted.push(id);
  }
}

// Reading, cleaning, grouping, and queueing the AI batches: all done by the parse-import job
async function recoverParsing(db: Db, boss: PgBoss, result: WatchdogResult) {
  const candidates = await db
    .select({ id: imports.id, recoveries: imports.recoveries })
    .from(imports)
    .where(
      and(
        inArray(imports.status, ["queued", "running"]),
        or(
          isNull(imports.stage),
          inArray(imports.stage, ["parse", "clean", "group", "photos"]),
          and(eq(imports.stage, "build"), isNull(imports.buildPlannedAt)),
        ),
        lt(imports.updatedAt, sql`now() - ${QUIET_FOR}`),
      ),
    );

  for (const candidate of candidates) {
    const jobs = await boss.findJobs(queues.parseImport.name, { key: candidate.id });
    if (jobs.some((job) => LIVE_JOB_STATES.has(job.state))) continue;

    if (candidate.recoveries >= MAX_RECOVERIES) {
      await db.update(imports).set({ status: "failed", error: stoppedMessage, finishedAt: new Date() }).where(eq(imports.id, candidate.id));
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
}

// The AI step: rows still waiting for the AI, but no AI batch queued or running for them
async function recoverBuilding(db: Db, boss: PgBoss, result: WatchdogResult) {
  const candidates = await db
    .select({ id: imports.id, recoveries: imports.recoveries, parseInfo: imports.parseInfo })
    .from(imports)
    .where(and(inArray(imports.status, ["queued", "running", "paused"]), eq(imports.stage, "build"), isNotNull(imports.buildPlannedAt)));

  for (const candidate of candidates) {
    const [{ waiting, lastChange }] = await db
      .select({ waiting: sql<number>`count(*)::int`, lastChange: sql<Date | null>`max(${importRows.updatedAt})` })
      .from(importRows)
      .where(and(eq(importRows.importId, candidate.id), eq(importRows.status, "pending")));
    if (waiting === 0) {
      await finishImportIfComplete(db, candidate.id);
      continue;
    }
    if (lastChange && Date.now() - new Date(lastChange).getTime() < 2 * 60_000) continue;

    const { rows } = await boss
      .getDb()
      .executeSql(`select count(*)::int as n from pgboss.job where name = $1 and state <= 'active' and data->>'importId' = $2`, [
        queues.buildBatch.name,
        candidate.id,
      ]);
    if ((rows[0] as { n: number }).n > 0) continue;

    if (candidate.recoveries >= MAX_RECOVERIES) {
      await db
        .update(importRows)
        .set({ status: "failed", reason: stoppedMessage })
        .where(and(eq(importRows.importId, candidate.id), eq(importRows.status, "pending")));
      await finishImportIfComplete(db, candidate.id);
      result.failed.push(candidate.id);
      continue;
    }

    const pending = await db
      .select({ rowNumber: importRows.rowNumber, raw: importRows.raw, productKey: importRows.productKey, cleaned: importRows.cleaned })
      .from(importRows)
      .where(and(eq(importRows.importId, candidate.id), eq(importRows.status, "pending")));
    // Planned the same way as the first time, so products whose listing is kept still don't go to the AI
    const batches = await planBuildBatches(db, groupByProduct(pending), candidate.parseInfo);

    await db.transaction(async (tx) => {
      await tx.update(imports).set({ recoveries: sql`${imports.recoveries} + 1` }).where(eq(imports.id, candidate.id));
      await boss.insert(
        queues.buildBatch.name,
        batches.map((b) => ({ data: { importId: candidate.id, ...b }, singletonKey: batchKey(candidate.id, b.productKeys) })),
        { db: fromDrizzle(tx, sql) },
      );
    });
    result.restarted.push(candidate.id);
  }
}
