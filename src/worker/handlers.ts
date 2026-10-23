import { sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { getAiProvider } from "@/server/ai";
import { getDb } from "@/server/db/client";
import { env } from "@/server/env";
import { recoverStalledImports } from "@/server/imports/watchdog";
import { AiPausedError } from "@/server/ai/rate-limit";
import { batchKey, failProducts, runBuildBatch } from "@/server/pipeline/build";
import { AttemptSuperseded, failImport, runParseImport, type EnqueueBuild, type EnqueuePhotos } from "@/server/pipeline/run-parse-import";
import { enqueuePhotoJobs, processPhotoBatch, rejectPhotoBatch } from "@/server/photos/process";
import { queues, type BuildBatchJob, type ParseImportJob, type PingJob, type PingResult, type ProcessPhotosJob, type TranslateBatchJob } from "@/server/queue/queues";
import { failTranslateBatch, runTranslateBatch } from "@/server/translations/run";
import { enqueuePendingTranslations } from "@/server/translations/state";

// Every job the worker runs, registered on a started pg-boss. Used by the always-on worker (index.ts) and by the
// bursts that run inside a web function on a host with no always-on machine (queue/serverless-worker.ts)
export async function startWorker(boss: PgBoss) {
  const db = getDb();
  const ai = getAiProvider();

  // AI batches are queued in the same transaction that records the plan
  const enqueueBuild: EnqueueBuild = async (tx, jobs) => {
    if (jobs.length) await boss.insert(queues.buildBatch.name, jobs, { db: fromDrizzle(tx, sql) });
  };
  // Photos to download from the sheet's links, queued in the same transaction that creates them
  const enqueuePhotos: EnqueuePhotos = async (tx, importId, photoIds) => {
    await enqueuePhotoJobs(tx, boss, importId, photoIds);
  };

  await boss.work<PingJob, PingResult>(queues.ping.name, async ([job]) => {
    const waitedMs = Date.now() - new Date(job.data.sentAt).getTime();
    console.log(`[worker] ping ${job.id} picked up after ${waitedMs} ms`);
    return { pongAt: new Date().toISOString(), waitedMs };
  });

  await boss.work<ParseImportJob, void, { includeMetadata: true }>(queues.parseImport.name, { includeMetadata: true }, async ([job]) => {
    const { importId } = job.data;
    const started = Date.now();
    console.log(`[worker] parse-import ${importId} (attempt ${job.retryCount + 1})`);
    try {
      await runParseImport(db, importId, { signal: job.signal, enqueueBuild, enqueuePhotos });
      console.log(`[worker] parse-import ${importId} finished in ${Date.now() - started} ms`);
    } catch (err) {
      // Another worker took over this import (we froze, or our job was handed out again). Its attempt
      // is the one that counts now, so stop quietly. Our job's result is ignored by pg-boss anyway
      if (err instanceof AttemptSuperseded || job.signal.aborted) {
        console.warn(`[worker] parse-import ${importId}: a newer attempt took over, stopping this one`);
        return;
      }
      console.error(`[worker] parse-import ${importId} failed`, err);
      throw err;
    }
  });

  // A parse job that failed every try (errors, or its worker died each time) lands here.
  // Tell the merchant instead of leaving the import at "running" forever
  await boss.work<ParseImportJob>(queues.parseImportDead.name, async ([job]) => {
    console.warn(`[worker] parse-import ${job.data.importId} ran out of tries, marking the import as failed`);
    await failImport(db, job.data.importId, "Reading the sheet failed several times in a row. Upload the file again");
  });

  // Takes AI_CONCURRENCY batches at a time and runs them side by side. While the queue is full it fetches
  // the next ones straight away instead of waiting for the next poll. Each batch still succeeds, fails and
  // retries on its own
  await boss.work<BuildBatchJob>(
    queues.buildBatch.name,
    { batchSize: env().AI_CONCURRENCY, perJobResults: true, burstWhenBatchFull: true, pollingIntervalSeconds: 1 },
    async (jobs) => {
      const settled = await Promise.allSettled(
        jobs.map(async (job) => {
          const { importId, productKeys, tier, keepListing } = job.data;
          const started = Date.now();
          await runBuildBatch(db, ai, job.data, { signal: job.signal });
          const kind = keepListing ? "listing kept, prices only" : tier;
          console.log(`[worker] build-batch ${importId}: ${productKeys.length} products (${kind}) in ${Date.now() - started} ms`);
          // Products whose English is new or changed get translated next. Also after a retry: rows already taken
          // by a translation job aren't queued again
          const queuedTranslations = await enqueuePendingTranslations(db, boss, { importId });
          if (queuedTranslations) console.log(`[worker] build-batch ${importId}: queued ${queuedTranslations} translation batches`);
        }),
      );
      return Promise.all(settled.map(async (result, i) => {
        if (result.status === "fulfilled") return { id: jobs[i].id, status: "completed" as const };
        // The AI is paused (rate limit) for longer than a job should wait: queue this batch again to start when
        // the pause ends. That's not a failure, so it doesn't use up one of the batch's tries
        if (result.reason instanceof AiPausedError) {
          const { data } = jobs[i];
          const until = result.reason.until;
          await boss.send(queues.buildBatch.name, data, { startAfter: until, singletonKey: `${batchKey(data.importId, data.productKeys)}:${until.getTime()}` });
          console.warn(`[worker] build-batch ${data.importId}: AI paused, batch moved to ${until.toISOString()}`);
          return { id: jobs[i].id, status: "completed" as const };
        }
        console.error(`[worker] build-batch ${jobs[i].data.importId} failed`, result.reason);
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return { id: jobs[i].id, status: "failed" as const, output: { message } };
      }));
    },
  );

  // An AI batch that failed every try: its products are marked Failed with a reason, the rest of the import goes on
  await boss.work<BuildBatchJob>(queues.buildBatchDead.name, async ([job]) => {
    console.warn(`[worker] build-batch for ${job.data.productKeys.length} products of ${job.data.importId} ran out of tries`);
    await failProducts(db, job.data, "The AI couldn't write this product after several tries");
  });

  // Same as the AI batches: AI_TRANSLATE_CONCURRENCY at a time (AI_CONCURRENCY when unset), a pause (rate limit, no
  // credit) puts the batch back in the queue without using up a try
  await boss.work<TranslateBatchJob>(
    queues.translateBatch.name,
    { batchSize: env().AI_TRANSLATE_CONCURRENCY ?? env().AI_CONCURRENCY, perJobResults: true, burstWhenBatchFull: true, pollingIntervalSeconds: 1 },
    async (jobs) => {
      const settled = await Promise.allSettled(
        jobs.map(async (job) => {
          const started = Date.now();
          await runTranslateBatch(db, ai, job.data, { signal: job.signal });
          console.log(`[worker] translate-batch ${job.data.scope}: ${job.data.productIds.length} products into ${job.data.locale} in ${Date.now() - started} ms`);
        }),
      );
      return Promise.all(settled.map(async (result, i) => {
        if (result.status === "fulfilled") return { id: jobs[i].id, status: "completed" as const };
        if (result.reason instanceof AiPausedError) {
          const { data } = jobs[i];
          const until = result.reason.until;
          await boss.send(queues.translateBatch.name, data, { startAfter: until, singletonKey: `translate:${data.scope}:${data.locale}:${until.getTime()}:${data.productIds[0]}` });
          console.warn(`[worker] translate-batch ${data.scope}: AI paused, batch moved to ${until.toISOString()}`);
          return { id: jobs[i].id, status: "completed" as const };
        }
        console.error(`[worker] translate-batch ${jobs[i].data.scope} failed`, result.reason);
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return { id: jobs[i].id, status: "failed" as const, output: { message } };
      }));
    },
  );

  // A translation batch that failed every try: its products are marked as failed (shoppers see English), the
  // import can finish, and the merchant can try again later
  await boss.work<TranslateBatchJob>(queues.translateBatchDead.name, async ([job]) => {
    console.warn(`[worker] translate-batch for ${job.data.productIds.length} products (${job.data.locale}) ran out of tries`);
    await failTranslateBatch(db, job.data, "The AI couldn't translate this product after several tries");
  });

  // Photos are resized with Sharp, which uses every CPU core for one photo already: two batches at a time is plenty
  await boss.work<ProcessPhotosJob>(queues.processPhotos.name, { localConcurrency: 2, pollingIntervalSeconds: 1 }, async ([job]) => {
    const started = Date.now();
    await processPhotoBatch(db, job.data, { signal: job.signal });
    console.log(`[worker] process-photos ${job.data.importId}: ${job.data.photoIds.length} photos in ${Date.now() - started} ms`);
  });

  // A photo batch that failed every try: its photos are marked Rejected, so the import can still finish
  await boss.work<ProcessPhotosJob>(queues.processPhotosDead.name, async ([job]) => {
    console.warn(`[worker] process-photos for ${job.data.photoIds.length} photos of ${job.data.importId} ran out of tries`);
    await rejectPhotoBatch(db, job.data);
  });

  await boss.work(queues.watchdog.name, async () => {
    const { restarted, failed } = await recoverStalledImports(db, boss);
    if (restarted.length) console.warn(`[watchdog] restarted imports with no job: ${restarted.join(", ")}`);
    if (failed.length) console.warn(`[watchdog] gave up on imports: ${failed.join(", ")}`);
  });
  // pg-boss makes sure only one worker runs it per minute, however many workers are running
  await boss.schedule(queues.watchdog.name, "* * * * *");

  return ai.name;
}
