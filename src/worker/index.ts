import { getDb } from "@/server/db/client";
import { recoverStalledImports } from "@/server/imports/watchdog";
import { AttemptSuperseded, failImport, runParseImport } from "@/server/pipeline/run-parse-import";
import { startBoss } from "@/server/queue/boss";
import { queues, type ParseImportJob, type PingJob, type PingResult } from "@/server/queue/queues";

async function main() {
  const boss = await startBoss("worker");
  const db = getDb();

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
      await runParseImport(db, importId, { signal: job.signal });
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

  await boss.work(queues.watchdog.name, async () => {
    const { restarted, failed } = await recoverStalledImports(db, boss);
    if (restarted.length) console.warn(`[watchdog] restarted imports with no job: ${restarted.join(", ")}`);
    if (failed.length) console.warn(`[watchdog] gave up on imports: ${failed.join(", ")}`);
  });
  // pg-boss makes sure only one worker runs it per minute, however many workers are running
  await boss.schedule(queues.watchdog.name, "* * * * *");

  console.log("[worker] started, waiting for jobs");

  let stopping = false;
  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal}: finishing current jobs, then stopping`);
    // Jobs still running after the timeout are picked up again on the next start
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[worker] failed to start", err);
  process.exit(1);
});
