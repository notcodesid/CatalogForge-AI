import { readFileSync, rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockProvider, resetMockState } from "@/server/ai/mock";
import { createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { runBuildBatch } from "@/server/pipeline/build";
import { runParseImport } from "@/server/pipeline/run-parse-import";
import { type BuildBatchJob, queues } from "@/server/queue/queues";
import { enqueuePendingTranslations } from "@/server/translations/state";
import { startTestBoss } from "@/test/boss";
import { setShopLanguages } from "@/test/fixtures";
import { testDatabaseUrl } from "@/test/global-setup";
import { createImport } from "./create-import";
import { listImports } from "./list";
import { getImportSummary } from "./queries";

const db = createDb(testDatabaseUrl());
let boss: PgBoss;
const SAMPLE = "samples/catalogforge_test_sheet.csv";
const photo = { name: "TC-PL-20.jpg", bytes: readFileSync("samples/test-files/09-photos/photos/TC-PL-20.jpg") };

beforeAll(async () => {
  boss = await startTestBoss();
});

beforeEach(async () => {
  await db.execute(sql`truncate imports, products, ai_cache, ai_calls, ai_status restart identity cascade`);
  await boss.deleteAllJobs();
  await setShopLanguages(db, true);
  resetMockState();
});

afterAll(async () => {
  await boss.stop();
  await db.$client.end();
  rmSync(env().STORAGE_DIR, { recursive: true, force: true });
});

// Reads the sheet and runs every AI batch, like the worker, then queues the translations
async function importAndBuild() {
  const { import: imp } = await createImport(db, boss, { fileName: "sheet.csv", bytes: readFileSync(SAMPLE), photos: [photo] });
  const queued: BuildBatchJob[] = [];
  await runParseImport(db, imp.id, { enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)) });
  for (const job of queued) await runBuildBatch(db, mockProvider, job);
  await enqueuePendingTranslations(db, boss, { importId: imp.id });
  return imp.id;
}

describe("listImports", () => {
  it("lists the newest import first, with the same counts as its full summary", async () => {
    const built = await importAndBuild();
    const waiting = (await createImport(db, boss, { fileName: "later.csv", bytes: readFileSync(SAMPLE).subarray(0, 300), waitForPhotos: true })).import.id;

    const { total, imports } = await listImports(db, { limit: 20, offset: 0 });
    expect(total).toBe(2);
    expect(imports.map((i) => i.id)).toEqual([waiting, built]);
    expect(imports[0]).toMatchObject({ status: "waiting_for_files", phase: "waiting for photos", rows: { pending: 0, done: 0 } });

    // The list is lighter than the summary, but must say the same thing
    const summary = (await getImportSummary(db, built))!;
    expect(imports[1]).toMatchObject({
      fileName: "sheet.csv",
      status: summary.status,
      // The photo still waits to be resized, then the translations
      phase: "processing photos",
      rows: summary.rows,
      products: summary.products,
      productOutcomes: summary.productOutcomes,
      photos: { total: 1, matched: 1, waitingToBeProcessed: 1, missing: summary.photos.missing.length, linksOverLimit: 0 },
      translations: { de: { done: 0, pending: 12, failed: 0 }, fr: { done: 0, pending: 12, failed: 0 } },
    });
    expect(imports[1].phase).toBe(summary.phase);
    expect(Object.values(imports[1].rows).reduce((a, b) => a + b, 0)).toBe(summary.totalRows);
  });

  it("pages through the queue", async () => {
    for (const name of ["a.csv", "b.csv", "c.csv"]) {
      await createImport(db, boss, { fileName: name, bytes: Buffer.from(`SKU,Name,Price\n${name},Vase,10\n`), waitForPhotos: true });
    }
    const first = await listImports(db, { limit: 2, offset: 0 });
    const second = await listImports(db, { limit: 2, offset: 2 });
    expect(first.imports.map((i) => i.fileName)).toEqual(["c.csv", "b.csv"]);
    expect(second.imports.map((i) => i.fileName)).toEqual(["a.csv"]);
    expect(second.total).toBe(3);
  });

  it("shows the AI batches that failed and are being tried again", async () => {
    const { import: imp } = await createImport(db, boss, { fileName: "sheet.csv", bytes: readFileSync(SAMPLE) });
    const queued: BuildBatchJob[] = [];
    await runParseImport(db, imp.id, { enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)) });
    const name = queues.buildBatch.name;
    const retrying = async () => {
      const listed = (await listImports(db, { limit: 20, offset: 0 })).imports[0].retrying;
      expect((await getImportSummary(db, imp.id))!.retrying).toEqual(listed);
      return listed;
    };

    // Waiting for its first try isn't trying again
    const id = (await boss.send(name, queued[0]))!;
    expect(await retrying()).toBeNull();
    // The first try failed: it waits for the second of 4
    await boss.fetch(name);
    await boss.fail(name, id, { message: "Provider overloaded (503)" });
    const products = queued[0].productKeys.length;
    expect(await retrying()).toEqual({ products, attempt: 2, attempts: 4 });
    // The second try is running, then fails too
    await db.execute(sql`update pgboss.job set start_after = now() where id = ${id}`);
    await boss.fetch(name);
    expect(await retrying()).toEqual({ products, attempt: 2, attempts: 4 });
    await boss.fail(name, id, { message: "Provider overloaded (503)" });
    expect(await retrying()).toEqual({ products, attempt: 3, attempts: 4 });
  });

  it("is empty before the first upload", async () => {
    expect(await listImports(db, { limit: 20, offset: 0 })).toEqual({ total: 0, imports: [] });
  });
});
