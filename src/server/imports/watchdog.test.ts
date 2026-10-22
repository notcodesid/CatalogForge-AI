import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { importRows, imports, photos, products, translationState } from "@/server/db/schema";
import type { CleanedRow, ParseInfo } from "@/server/pipeline/types";
import { queues } from "@/server/queue/queues";
import { startTestBoss } from "@/test/boss";
import { testDatabaseUrl } from "@/test/global-setup";
import { MAX_RECOVERIES, recoverStalledImports } from "./watchdog";

const db = createDb(testDatabaseUrl());
let boss: PgBoss;

const cleanedRow: CleanedRow = {
  sku: "A-1", parentSku: null, title: "Mug", descriptionHtml: null, descriptionText: null, color: null, colorSource: null,
  size: null, sizeMm: null, weightGrams: null, material: null, priceCents: 1000, currency: "EUR", currencyAssumed: false,
  notes: null, image: null, category: null, brand: null, language: "en", role: "variant", options: {}, extra: {}, issues: [],
};

beforeAll(async () => {
  boss = await startTestBoss();
});

beforeEach(async () => {
  await db.execute(sql`truncate imports, products restart identity cascade`);
  await boss.deleteAllJobs();
});

afterAll(async () => {
  await boss.stop();
  await db.$client.end();
});

// An import that claims to be running, last touched 5 minutes ago
async function stalledImport(fields: Partial<typeof imports.$inferInsert> = {}) {
  const id = randomUUID();
  await db.insert(imports).values({ id, sheetFileName: "sheet.csv", status: "running", stage: "clean", ...fields });
  await db.execute(sql`update imports set updated_at = now() - interval '5 minutes' where id = ${id}`);
  return id;
}

async function getImport(id: string) {
  const [row] = await db.select().from(imports).where(eq(imports.id, id));
  return row;
}

describe("recoverStalledImports", () => {
  it("restarts a running import whose job has gone missing", async () => {
    const id = await stalledImport();

    const result = await recoverStalledImports(db, boss);

    expect(result.restarted).toEqual([id]);
    expect(await getImport(id)).toMatchObject({ status: "queued", recoveries: 1 });
    expect(await boss.findJobs(queues.parseImport.name, { key: id })).toHaveLength(1);
  });

  it(`gives up after ${MAX_RECOVERIES} restarts and fails the import with a message`, async () => {
    const id = await stalledImport({ recoveries: MAX_RECOVERIES });

    const result = await recoverStalledImports(db, boss);

    expect(result.failed).toEqual([id]);
    expect(await getImport(id)).toMatchObject({ status: "failed", error: expect.stringContaining("stopped unexpectedly") });
  });

  it("leaves an import alone while its job is waiting or running", async () => {
    const id = await stalledImport();
    await boss.send(queues.parseImport.name, { importId: id }, { singletonKey: id });

    expect(await recoverStalledImports(db, boss)).toEqual({ restarted: [], failed: [] });
  });

  it("leaves recently changed imports alone (they're probably between two steps)", async () => {
    const id = randomUUID();
    await db.insert(imports).values({ id, sheetFileName: "sheet.csv", status: "running", stage: "clean" });

    expect(await recoverStalledImports(db, boss)).toEqual({ restarted: [], failed: [] });
  });

  it("restarts an import that finished grouping but never queued its AI batches", async () => {
    const id = await stalledImport({ stage: "build" });

    expect((await recoverStalledImports(db, boss)).restarted).toEqual([id]);
    expect(await boss.findJobs(queues.parseImport.name, { key: id })).toHaveLength(1);
  });

  it("re-queues AI batches when rows are waiting for the AI but no batch job exists", async () => {
    const id = await stalledImport({ stage: "build", buildPlannedAt: new Date() });
    await db.insert(importRows).values({ importId: id, rowNumber: 2, raw: {}, rowHash: "x", productKey: "sku:a-1", cleaned: cleanedRow });
    await db.execute(sql`update import_rows set updated_at = now() - interval '5 minutes'`);

    expect((await recoverStalledImports(db, boss)).restarted).toEqual([id]);
    const batches = await boss.findJobs<{ importId: string; productKeys: string[] }>(queues.buildBatch.name);
    expect(batches.map((b) => b.data)).toEqual([{ importId: id, productKeys: ["sku:a-1"], tier: "cheap" }]);
    expect(await getImport(id)).toMatchObject({ recoveries: 1 });
  });

  it("re-queues a product whose listing is kept as 'prices only' again, not as an AI batch", async () => {
    const parseInfo: ParseInfo = {
      fileType: "csv", headerRow: 1, columns: { sku: "SKU", title: "Name", price: "Price" }, unmappedColumns: [], hints: {},
      blankRows: 0, format: "generic", optionColumns: [], ignoredRows: [],
    };
    const id = await stalledImport({ stage: "build", buildPlannedAt: new Date(), parseInfo });
    // The mug's listing was written from "Mug" and "Stoneware, hand wash only". This price list only says "Mug"
    const sourceInput = { key: "sku:a-1", language: "en", sourceRows: [{ row: 2, cells: { Name: "Mug", Notes: "Stoneware, hand wash only" } }], variants: [] };
    await db.insert(products).values({ productKey: "sku:a-1", handle: "mug", title: "Stoneware Mug", sourceInput });
    await db.insert(importRows).values({ importId: id, rowNumber: 2, raw: { SKU: "A-1", Name: "Mug", Price: "12" }, rowHash: "x", productKey: "sku:a-1", cleaned: cleanedRow });
    await db.execute(sql`update import_rows set updated_at = now() - interval '5 minutes'`);

    expect((await recoverStalledImports(db, boss)).restarted).toEqual([id]);
    const batches = await boss.findJobs(queues.buildBatch.name);
    expect(batches.map((b) => b.data)).toEqual([{ importId: id, productKeys: ["sku:a-1"], tier: "cheap", keepListing: true }]);
  });

  it("re-queues photo processing when photos are waiting but no photo batch exists, and only once", async () => {
    const id = await stalledImport({ stage: "build", buildPlannedAt: new Date() });
    await db.insert(photos).values({ importId: id, fileName: "A-1.jpg", status: "matched", originalPath: "imports/x/a.jpg" });
    await db.execute(sql`update photos set updated_at = now() - interval '5 minutes'`);

    expect((await recoverStalledImports(db, boss)).restarted).toEqual([id]);
    const jobs = await boss.findJobs<{ importId: string; photoIds: string[] }>(queues.processPhotos.name);
    expect(jobs.map((j) => j.data.importId)).toEqual([id]);
    // The import can't be done while a photo is still waiting
    expect(await getImport(id)).toMatchObject({ status: "running" });
    // Next minute: the batch is queued, so nothing to do
    expect(await recoverStalledImports(db, boss)).toEqual({ restarted: [], failed: [] });
  });

  it("queues translations again when they're waiting but their job is gone", async () => {
    const [product] = await db.insert(products).values({ productKey: "sku:a-1", handle: "mug", title: "Mug" }).returning();
    await db.insert(translationState).values({ productId: product.id, locale: "de", status: "pending", queuedAt: new Date() });
    await db.execute(sql`update translation_state set updated_at = now() - interval '5 minutes'`);

    await recoverStalledImports(db, boss);
    const jobs = await boss.findJobs<{ productIds: string[]; locale: string; scope: string }>(queues.translateBatch.name);
    expect(jobs.map((j) => j.data)).toEqual([{ scope: "catalog", importId: null, locale: "de", productIds: [product.id] }]);
    // Next minute: the job is queued, so nothing to do
    await recoverStalledImports(db, boss);
    expect(await boss.findJobs(queues.translateBatch.name)).toHaveLength(1);
  });

  it("leaves an import alone while its AI batches are waiting or running", async () => {
    const id = await stalledImport({ stage: "build", buildPlannedAt: new Date() });
    await db.insert(importRows).values({ importId: id, rowNumber: 2, raw: {}, rowHash: "x", productKey: "sku:a-1", cleaned: cleanedRow });
    await db.execute(sql`update import_rows set updated_at = now() - interval '5 minutes'`);
    await boss.send(queues.buildBatch.name, { importId: id, productKeys: ["sku:a-1"], tier: "cheap" }, { singletonKey: `${id}:x` });

    expect(await recoverStalledImports(db, boss)).toEqual({ restarted: [], failed: [] });
  });
});
