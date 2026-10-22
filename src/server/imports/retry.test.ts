import { readFileSync, rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockProvider, resetMockState } from "@/server/ai/mock";
import { AiPermanentError, type AiProvider } from "@/server/ai/provider";
import { createDb } from "@/server/db/client";
import { importRows, imports } from "@/server/db/schema";
import { env } from "@/server/env";
import { runBuildBatch } from "@/server/pipeline/build";
import { runParseImport } from "@/server/pipeline/run-parse-import";
import { queues, type BuildBatchJob, type TranslateBatchJob } from "@/server/queue/queues";
import { runTranslateBatch } from "@/server/translations/run";
import { enqueuePendingTranslations } from "@/server/translations/state";
import { startTestBoss } from "@/test/boss";
import { setShopLanguages } from "@/test/fixtures";
import { testDatabaseUrl } from "@/test/global-setup";
import { createImport } from "./create-import";
import { getImportSummary } from "./queries";
import { retryImport, RetryError } from "./retry";

const db = createDb(testDatabaseUrl());
let boss: PgBoss;
const SAMPLE = readFileSync("samples/catalogforge_test_sheet.csv");

// Refuses every request of one kind, like a provider with a bad key; everything else goes to the mock AI
const refusing = (purpose: "build" | "translate"): AiProvider => ({
  ...mockProvider,
  generate: (request) => (request.purpose === purpose ? Promise.reject(new AiPermanentError("API key not valid")) : mockProvider.generate(request)),
});

beforeAll(async () => {
  boss = await startTestBoss();
});

beforeEach(async () => {
  await db.execute(sql`truncate imports, products, ai_cache, ai_calls, ai_status restart identity cascade`);
  await boss.deleteAllJobs();
  await setShopLanguages(db, false);
  resetMockState();
});

afterAll(async () => {
  await boss.stop();
  await db.$client.end();
  rmSync(env().STORAGE_DIR, { recursive: true, force: true });
});

async function importWith(provider: AiProvider, bytes: Buffer = SAMPLE) {
  const { import: imp } = await createImport(db, boss, { fileName: "sheet.csv", bytes });
  const queued: BuildBatchJob[] = [];
  await runParseImport(db, imp.id, { enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)) });
  for (const job of queued) await runBuildBatch(db, provider, job);
  return imp.id;
}

// Takes every queued job of a queue, runs it and marks it complete, like the worker
async function runQueued<T extends object>(name: string, run: (data: T) => Promise<void>) {
  for (;;) {
    const jobs = await boss.fetch<T>(name, { batchSize: 100 });
    if (!jobs.length) return;
    for (const job of jobs) await run(job.data);
    await boss.complete(
      name,
      jobs.map((j) => j.id),
    );
  }
}

describe("retryImport", () => {
  it("puts rows the AI failed on back in the queue, and the import finishes once they're written", async () => {
    const id = await importWith(refusing("build"));
    expect(await getImportSummary(db, id)).toMatchObject({ status: "done", rows: { failed: 18, done: 0 } });

    expect(await retryImport(db, boss, id)).toEqual({ rowsRetried: 18, translationsRetried: 0, translationBatches: 0, rowsNotRetryable: 0 });
    expect(await getImportSummary(db, id)).toMatchObject({ status: "running", phase: "writing products", rows: { pending: 18, failed: 0 } });
    const batches = (await boss.findJobs<BuildBatchJob>(queues.buildBatch.name)).map((j) => j.data);
    expect(batches.flatMap((b) => b.productKeys)).toHaveLength(12);

    await runQueued<BuildBatchJob>(queues.buildBatch.name, (job) => runBuildBatch(db, mockProvider, job));
    expect(await getImportSummary(db, id)).toMatchObject({ status: "done", rows: { failed: 0, pending: 0 } });
    // Nothing left to try again
    expect((await retryImport(db, boss, id)).rowsRetried).toBe(0);
  });

  it("leaves rows that failed while the sheet was read, and says so", async () => {
    const id = await importWith(refusing("build"));
    // One row failed while reading (it has no product): trying again wouldn't help
    await db.update(importRows).set({ productKey: null, reason: "Not a product row" }).where(and(eq(importRows.importId, id), eq(importRows.rowNumber, 2)));
    const result = await retryImport(db, boss, id);
    expect(result).toMatchObject({ rowsRetried: 17, rowsNotRetryable: 1 });
  });

  it("tries this import's failed translations again", async () => {
    await setShopLanguages(db, true);
    const id = await importWith(mockProvider);
    await enqueuePendingTranslations(db, boss, { importId: id });
    await runQueued<TranslateBatchJob>(queues.translateBatch.name, (job) => runTranslateBatch(db, refusing("translate"), job));
    expect(await getImportSummary(db, id)).toMatchObject({ status: "done", translations: { de: { failed: 12 }, fr: { failed: 12 } } });

    const result = await retryImport(db, boss, id);
    expect(result).toMatchObject({ rowsRetried: 0, translationsRetried: 12 });
    expect(result.translationBatches).toBeGreaterThan(0);
    expect(await getImportSummary(db, id)).toMatchObject({ status: "running", phase: "translating" });

    await runQueued<TranslateBatchJob>(queues.translateBatch.name, (job) => runTranslateBatch(db, mockProvider, job));
    expect(await getImportSummary(db, id)).toMatchObject({ status: "done", translations: { de: { done: 12, failed: 0 }, fr: { done: 12, failed: 0 } } });
  });

  it("refuses what can't be retried, with a reason the merchant can act on", async () => {
    const reason = (id: string) => retryImport(db, boss, id).catch((e: RetryError) => [e.status, e.message]);

    const unreadable = await importWith(mockProvider, Buffer.from("SKU,Name,Price\n"));
    expect((await db.select().from(imports).where(eq(imports.id, unreadable)))[0].status).toBe("failed");
    expect(await reason(unreadable)).toEqual([409, "This file couldn't be imported (The sheet has a header row but no product rows). Fix it and upload it again"]);

    const waiting = (await createImport(db, boss, { fileName: "w.csv", bytes: SAMPLE, waitForPhotos: true })).import.id;
    expect(await reason(waiting)).toEqual([409, "This import hasn't started yet. Start it first"]);
    expect(await reason("00000000-0000-0000-0000-000000000000")).toEqual([404, "Import not found"]);
  });
});
