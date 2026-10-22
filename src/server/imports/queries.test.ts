import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mockProvider, resetMockState } from "@/server/ai/mock";
import { createDb } from "@/server/db/client";
import { products } from "@/server/db/schema";
import { env } from "@/server/env";
import { failProducts, runBuildBatch } from "@/server/pipeline/build";
import { runParseImport } from "@/server/pipeline/run-parse-import";
import type { BuildBatchJob } from "@/server/queue/queues";
import { createTestImport, setShopLanguages } from "@/test/fixtures";
import { testDatabaseUrl } from "@/test/global-setup";
import { listImports } from "./list";
import { getImportSummary } from "./queries";

const db = createDb(testDatabaseUrl());
const SAMPLE = "samples/catalogforge_test_sheet.csv";
const csv = (text: string) => new TextEncoder().encode(text);

beforeEach(async () => {
  await db.execute(sql`truncate imports, products, ai_cache, ai_calls, ai_status restart identity cascade`);
  resetMockState();
  // Without translations to wait for, an import is done as soon as its products are written
  await setShopLanguages(db, false);
});

afterAll(async () => {
  await db.$client.end();
  rmSync(env().STORAGE_DIR, { recursive: true, force: true });
});

// Reads the sheet, then runs every AI batch (all but `skip`), like the worker
async function build(id: string, skip = 0) {
  const queued: BuildBatchJob[] = [];
  await runParseImport(db, id, { enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)) });
  for (const job of queued.slice(skip)) await runBuildBatch(db, mockProvider, job);
  return queued;
}

async function importAndBuild(file: string, bytes?: Uint8Array) {
  const id = await createTestImport(db, file, bytes);
  await build(id);
  return id;
}

const summary = async (id: string) => (await getImportSummary(db, id))!;

describe("new products and products already in the catalog", () => {
  it("counts products whose SKUs came in an earlier, differently laid out file as updated, and names that file", async () => {
    const first = await importAndBuild(
      "shopify_products_export.csv",
      csv("SKU,Name,Price\nTC-PL-20,Terracotta Planter,24.99\nLCC-45,Linen Cushion Cover,29.00\nWC-01,Watering Can,18.00\n"),
    );
    // Another layout (a parent column), so other product keys: the planter and the can are found by their SKUs
    const second = await importAndBuild(
      "level1_basic.csv",
      csv("SKU,Parent SKU,Name,Size,Price\nTC-PL-20,TC-PL,Terracotta Planter,20 cm,26.00\nTC-PL-30,TC-PL,Terracotta Planter,30 cm,32.00\nWC-01,,Watering Can,,19.00\nOB-01,,Oak Board,,15.00\n"),
    );

    expect(await db.select().from(products)).toHaveLength(4);
    expect(await summary(second)).toMatchObject({
      status: "done",
      products: 3,
      productOutcomes: { new: 1, updated: 2, deleted: 0, failed: 0 },
      earlierFiles: ["shopify_products_export.csv"],
    });
    // The first file still added all three, though two of them now belong to the second file
    expect(await summary(first)).toMatchObject({ products: 3, productOutcomes: { new: 3, updated: 0, deleted: 0, failed: 0 }, earlierFiles: [] });

    // The Upload tab's list says the same
    const { imports } = await listImports(db, { limit: 20, offset: 0 });
    expect(imports.map((i) => [i.fileName, i.productOutcomes])).toEqual([
      ["level1_basic.csv", { new: 1, updated: 2, deleted: 0, failed: 0 }],
      ["shopify_products_export.csv", { new: 3, updated: 0, deleted: 0, failed: 0 }],
    ]);
  });

  it("counts every product of the same file uploaded again as already in the catalog", async () => {
    const first = await importAndBuild(SAMPLE);
    const again = await importAndBuild(SAMPLE);

    expect(await db.select().from(products)).toHaveLength(12);
    expect(await summary(again)).toMatchObject({
      products: 12,
      productOutcomes: { new: 0, updated: 12, deleted: 0, failed: 0 },
      earlierFiles: ["catalogforge_test_sheet.csv"],
    });
    expect((await summary(first)).productOutcomes).toEqual({ new: 12, updated: 0, deleted: 0, failed: 0 });
  });

  it("counts a product the merchant deleted as skipped, and one deleted later as what the upload did at the time", async () => {
    const first = await importAndBuild(SAMPLE);
    await db.update(products).set({ deletedAt: new Date() }).where(eq(products.title, "Bamboo Bowl Set"));

    const again = await importAndBuild(SAMPLE);
    expect((await summary(again)).productOutcomes).toEqual({ new: 0, updated: 11, deleted: 1, failed: 0 });
    expect((await summary(first)).productOutcomes).toEqual({ new: 12, updated: 0, deleted: 0, failed: 0 });
  });

  it("counts a product added by another upload while this one waited to start as already there", async () => {
    const waiting = await createTestImport(db, "later.csv", csv("SKU,Name,Price\nX-1,Blue Vase,20.00\n"));
    const other = await importAndBuild("first.csv", csv("SKU,Name,Price\nX-1,Blue Vase,22.00\n"));
    await build(waiting);

    expect(await db.select().from(products)).toHaveLength(1);
    expect(await summary(other)).toMatchObject({ productOutcomes: { new: 1, updated: 0 } });
    expect(await summary(waiting)).toMatchObject({ productOutcomes: { new: 0, updated: 1 }, earlierFiles: ["first.csv"] });
  });

  it("leaves out products still being written, and counts the ones that failed", async () => {
    const id = await createTestImport(db, SAMPLE);
    const queued = await build(id, 1);
    const waiting = queued[0].productKeys.length;

    let s = await summary(id);
    expect(s.status).toBe("running");
    expect(s.productOutcomes).toEqual({ new: s.products - waiting, updated: 0, deleted: 0, failed: 0 });
    // The files are only looked up once the import is done
    expect(s.earlierFiles).toEqual([]);

    await failProducts(db, queued[0], "The AI provider refused the request");
    s = await summary(id);
    expect(s.status).toBe("done");
    expect(s.productOutcomes).toEqual({ new: s.products - waiting, updated: 0, deleted: 0, failed: waiting });
  });
});
