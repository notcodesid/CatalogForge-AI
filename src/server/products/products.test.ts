import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockProvider, resetMockState } from "@/server/ai/mock";
import { createDb } from "@/server/db/client";
import { photos, products, translationState } from "@/server/db/schema";
import { env } from "@/server/env";
import { runBuildBatch } from "@/server/pipeline/build";
import { runParseImport } from "@/server/pipeline/run-parse-import";
import { queues, type BuildBatchJob, type TranslateBatchJob } from "@/server/queue/queues";
import { startTestBoss } from "@/test/boss";
import { createTestImport, setShopLanguages } from "@/test/fixtures";
import { testDatabaseUrl } from "@/test/global-setup";
import { productDetail } from "./detail";
import { listProducts, productListQuery } from "./list";
import { approveProduct, bulkApprove, deleteProduct, editProduct, productEdit, restoreProduct, sendBack } from "./review";

const db = createDb(testDatabaseUrl());
let boss: PgBoss;
const SAMPLE = "samples/catalogforge_test_sheet.csv";
const encode = (text: string) => new TextEncoder().encode(text);

beforeAll(async () => {
  boss = await startTestBoss();
});

beforeEach(async () => {
  await db.execute(sql`truncate imports, products, ai_cache, ai_calls, ai_status restart identity cascade`);
  await boss.deleteAllJobs();
  delete process.env.MOCK_AI_MODE;
  resetMockState();
  await setShopLanguages(db, false);
});

afterAll(async () => {
  await boss.stop();
  await db.$client.end();
  rmSync(env().STORAGE_DIR, { recursive: true, force: true });
});

// The whole import like the worker runs it, with the mock AI
async function importAndBuild(file: string, bytes?: Uint8Array) {
  const id = await createTestImport(db, file, bytes);
  const queued: BuildBatchJob[] = [];
  await runParseImport(db, id, { enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)) });
  for (const job of queued) await runBuildBatch(db, mockProvider, job);
  return id;
}

async function byTitle(title: string) {
  const [row] = await db.select().from(products).where(eq(products.title, title));
  return row;
}

const list = (query: Record<string, string> = {}) => listProducts(db, productListQuery.parse(query));

describe("listProducts", () => {
  it("pages through the catalog, with each product's price range, variants, photo and translations", async () => {
    const importId = await importAndBuild(SAMPLE);
    const first = await list({ pageSize: "10" });
    const second = await list({ pageSize: "10", page: "2" });
    expect(first).toMatchObject({ total: 12, page: 1, pageSize: 10, pages: 2 });
    expect(first.products).toHaveLength(10);
    expect(new Set([...first.products, ...second.products].map((p) => p.id)).size).toBe(12);

    const [planter] = (await list({ search: "TC-PL-30" })).products;
    expect(planter).toMatchObject({
      title: "Hand-thrown Terracotta Planter",
      status: "needs_review",
      minPriceCents: 2499,
      maxPriceCents: 3990,
      currency: "EUR",
      currencies: ["EUR"],
      variantCount: 3,
      variantsWithoutPrice: 1,
      thumbnailUrl: null,
      translations: {},
      lastImportId: importId,
    });
    expect(planter.lowestConfidence).toBe(Math.min(...Object.values(planter.confidence)));

    // A photo of the bowls shows as the row's thumbnail
    const bowls = await byTitle("Bamboo Bowl Set");
    const [photo] = await db
      .insert(photos)
      .values({ importId, fileName: "BW-SET.jpg", storagePath: "photos/a.webp", thumbnailPath: "photos/a-thumb.webp", contentHash: "a", width: 800, height: 800, productId: bowls.id, status: "matched", processedAt: new Date() })
      .returning();
    expect((await list({ search: "Bamboo" })).products[0].thumbnailUrl).toBe(`/api/photos/${photo.id}?size=thumb`);
  });

  it("searches titles, handles and SKUs, and filters by status, category, import and confidence", async () => {
    const importId = await importAndBuild(SAMPLE);
    expect((await list({ search: "terracotta" })).products.map((p) => p.title)).toContain("Hand-thrown Terracotta Planter");
    expect((await list({ search: "bamboo-bowl" })).products.map((p) => p.handle)).toEqual(["bamboo-bowl-set"]);
    // Wildcards in the search are plain characters
    expect((await list({ search: "%" })).total).toBe(0);

    const inReview = await db.select().from(products).where(eq(products.status, "needs_review"));
    expect((await list({ status: "needs_review" })).total).toBe(inReview.length);
    expect((await list({ status: "ready,needs_review" })).total).toBe(12);

    const planters = await list({ category: "Home & Garden > Planters" });
    expect(planters.total).toBeGreaterThan(0);
    expect(planters.products.every((p) => p.category === "Home & Garden > Planters")).toBe(true);
    // A part of the tree includes everything under it
    expect((await list({ category: "Home & Garden" })).total).toBeGreaterThan(planters.total);

    expect((await list({ importId })).total).toBe(12);
    expect((await list({ importId: randomUUID() })).total).toBe(0);

    const unsure = await list({ maxConfidence: "69" });
    expect(unsure.total).toBeGreaterThan(0);
    expect(unsure.products.every((p) => p.lowestConfidence !== null && p.lowestConfidence <= 69)).toBe(true);
  });

  it("sorts by price and by confidence, products without a value last", async () => {
    await importAndBuild(SAMPLE);
    const prices = (await list({ sort: "price", pageSize: "100" })).products.map((p) => p.minPriceCents);
    const priced = prices.filter((p): p is number => p !== null);
    expect(priced).toEqual([...priced].sort((a, b) => a - b));
    expect(prices.slice(priced.length).every((p) => p === null)).toBe(true);
    const descending = (await list({ sort: "price", order: "desc", pageSize: "100" })).products.map((p) => p.minPriceCents).filter((p): p is number => p !== null);
    expect(descending).toEqual([...priced].reverse());

    const confidence = (await list({ sort: "confidence", pageSize: "100" })).products.map((p) => p.lowestConfidence).filter((c): c is number => c !== null);
    expect(confidence).toEqual([...confidence].sort((a, b) => a - b));
    // Newest change first by default
    const updated = (await list({ pageSize: "100" })).products.map((p) => new Date(p.updatedAt).getTime());
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
  });

  it("refuses a page size or sort it doesn't know", () => {
    expect(productListQuery.safeParse({ pageSize: "7" }).success).toBe(false);
    expect(productListQuery.safeParse({ sort: "colour" }).success).toBe(false);
    expect(productListQuery.safeParse({ status: "ready,bogus" }).success).toBe(false);
  });
});

describe("productDetail", () => {
  it("shows the AI's listing next to the supplier's rows and the text it was written from", async () => {
    await importAndBuild(SAMPLE);
    const planter = await byTitle("Hand-thrown Terracotta Planter");
    const detail = (await productDetail(db, planter.id))!;
    expect(detail.sourceRows.map((r) => r.rowNumber)).toEqual([2, 3, 6, 20]);
    expect(detail.sourceRows[0].raw["Supplier SKU"]).toBe("TC-PL-20");
    expect(detail.variants.map((v) => v.sku).sort()).toEqual(["TC-PL-20", "TC-PL-30", "TC-PL-40"]);
    expect(detail.claims[0]).toMatchObject({ text: "frost-resistant", source: "catalogforge_test_sheet.csv, row 2, column Notes" });
    expect(detail.writtenFrom?.sourceRows.length).toBeGreaterThan(0);
    expect(detail.reviewReasons).toContain("Row 3: No price");
    expect(detail.lastImport?.fileName).toBe("catalogforge_test_sheet.csv");
    expect(detail.translations).toEqual([
      { locale: "de", enabled: false, status: null, error: null },
      { locale: "fr", enabled: false, status: null, error: null },
    ]);
    expect(await productDetail(db, randomUUID())).toBeNull();
  });
});

describe("editProduct", () => {
  const bench = (description: string) => encode(`SKU,Name,Description,Price\nA-1,Garden Bench,"${description}",120\n`);

  it("keeps the merchant's edit when the sheet is uploaded again, while the AI still updates the rest", async () => {
    await importAndBuild("bench.csv", bench("Oak bench."));
    const [product] = await db.select().from(products);
    const edited = await editProduct(db, boss, product.id, { title: "  Oak Garden Bench " });
    expect(edited.changed).toEqual(["title"]);
    expect(edited.product).toMatchObject({ title: "Oak Garden Bench", editedFields: ["title"] });
    expect(edited.product.confidence.title).toBe(100);

    await importAndBuild("bench.csv", bench("Solid oak bench, oiled."));
    const after = (await productDetail(db, product.id))!;
    expect(after.title).toBe("Oak Garden Bench");
    expect(after.descriptionHtml).toContain("Solid oak bench, oiled.");
  });

  it("cleans what the merchant writes, counts it as certain, and warns about claims the supplier never made", async () => {
    await importAndBuild("bench.csv", bench("Oak bench."));
    const [product] = await db.select().from(products);
    const edited = await editProduct(db, boss, product.id, {
      descriptionHtml: "<p onclick='x()'>Organic, frost-proof oak.</p><script>bad()</script>",
      category: product.category,
      tags: ["Oak", "oak", " Bench "],
      attributes: { " Material ": "solid oak", Care: "  " },
    });
    // The category didn't change, so it isn't the merchant's now
    expect(edited.changed.sort()).toEqual(["attributes", "descriptionHtml", "tags"]);
    expect(edited.product).toMatchObject({ descriptionHtml: "<p>Organic, frost-proof oak.</p>", tags: ["oak", "bench"], attributes: { material: "solid oak" } });
    expect(edited.product.confidence).toMatchObject({ description: 100, tags: 100, "attributes.material": 100 });
    expect(edited.warnings).toEqual([
      `The description says "frost proof", but the supplier's text never does`,
      `The description says "organic", but the supplier's text never does`,
    ]);

    // The same values again: nothing changes
    expect((await editProduct(db, boss, product.id, { tags: ["oak", "bench"] })).changed).toEqual([]);
  });

  it("refuses what it can't save, with the reason", async () => {
    await importAndBuild("bench.csv", bench("Oak bench."));
    const [product] = await db.select().from(products);
    const refused = (edit: Parameters<typeof editProduct>[3], id = product.id) =>
      editProduct(db, boss, id, edit).then(
        () => null,
        (e: { status: number; message: string }) => [e.status, e.message],
      );
    expect(await refused({ category: "Garden > Pots" })).toEqual([400, '"Garden > Pots" isn\'t in the category list']);
    expect(await refused({ attributes: { Colour: "red" } })).toEqual([400, '"colour" is set per variant, not as an attribute']);
    expect(await refused({ title: "   " })).toEqual([400, "The title can't be empty"]);
    expect(await refused({ title: "X" }, randomUUID())).toEqual([404, "Product not found"]);
    await deleteProduct(db, product.id);
    expect(await refused({ title: "X" })).toEqual([409, "This product is deleted. Restore it first"]);

    expect(productEdit.safeParse({}).success).toBe(false);
    expect(productEdit.safeParse({ status: "approved" }).success).toBe(false);
  });

  it("translates only the fields the merchant changed again", async () => {
    await importAndBuild("bench.csv", bench("Oak bench."));
    const [product] = await db.select().from(products);
    await setShopLanguages(db, true);
    // Translations already up to date (as if the worker had translated them)
    await db.insert(translationState).values([
      { productId: product.id, locale: "de", status: "done" },
      { productId: product.id, locale: "fr", status: "done" },
    ]);

    await editProduct(db, boss, product.id, { title: "Oak Garden Bench" });
    const states = await db.select().from(translationState).where(eq(translationState.productId, product.id));
    expect(states.map((s) => [s.locale, s.status]).sort()).toEqual([
      ["de", "pending"],
      ["fr", "pending"],
    ]);
    const jobs = await boss.findJobs<TranslateBatchJob>(queues.translateBatch.name);
    expect(jobs.map((j) => [j.data.locale, j.data.productIds]).sort()).toEqual([
      ["de", [product.id]],
      ["fr", [product.id]],
    ]);
  });
});

describe("approving and sending back", () => {
  it("approves only a product a shopper can buy", async () => {
    await importAndBuild(SAMPLE);
    const planter = await byTitle("Hand-thrown Terracotta Planter");
    await expect(approveProduct(db, planter.id)).rejects.toMatchObject({
      status: 409,
      message: "SKU TC-PL-30 has no price. Add the price in the sheet and upload it again, then approve",
    });

    const bowls = await byTitle("Bamboo Bowl Set");
    const first = await approveProduct(db, bowls.id);
    expect(first).toMatchObject({ alreadyApproved: false, product: { status: "approved" } });
    expect(first.product.approvedAt).not.toBeNull();
    const again = await approveProduct(db, bowls.id);
    expect(again.alreadyApproved).toBe(true);
    expect(again.product.approvedAt).toEqual(first.product.approvedAt);

    await expect(approveProduct(db, randomUUID())).rejects.toMatchObject({ status: 404 });
    await deleteProduct(db, bowls.id);
    await expect(approveProduct(db, bowls.id)).rejects.toMatchObject({ status: 409, message: "This product is deleted. Restore it first" });
  });

  it("sends a product back with the merchant's reason, which survives a prices-only re-upload until it's approved", async () => {
    await importAndBuild(SAMPLE);
    const bowls = await byTitle("Bamboo Bowl Set");
    await approveProduct(db, bowls.id);

    const sent = await sendBack(db, bowls.id, "The photo shows; the wrong colour");
    expect(sent.product).toMatchObject({ status: "needs_review", approvedAt: null });
    expect(sent.product.reviewReasons[0]).toBe("Sent back: The photo shows, the wrong colour");
    // Sent back again: the new note replaces the old one
    const again = await sendBack(db, bowls.id, "Wrong colour");
    expect(again.product.reviewReasons.filter((r) => r.startsWith("Sent back"))).toEqual(["Sent back: Wrong colour"]);

    // A price list for it keeps the listing, and the note
    await importAndBuild("prices.csv", encode("SKU,Name,Price,Currency\nBW-SET,Bamboo Bowl Set,26.00,EUR\n"));
    const afterPrices = (await productDetail(db, bowls.id))!;
    expect(afterPrices.status).toBe("needs_review");
    expect(afterPrices.reviewReasons).toContain("Sent back: Wrong colour");
    expect(afterPrices.variants[0].priceCents).toBe(2600);

    const approved = await approveProduct(db, bowls.id);
    expect(approved.product.status).toBe("approved");
    expect([...approved.product.reviewReasons, ...approved.product.contentReviewReasons].some((r) => r.startsWith("Sent back"))).toBe(false);
  });

  it("approves many at once, and says which it couldn't and why", async () => {
    const importId = await importAndBuild(SAMPLE);
    const bowls = await byTitle("Bamboo Bowl Set");
    const planter = await byTitle("Hand-thrown Terracotta Planter");
    const can = await byTitle("Watering Can");
    await deleteProduct(db, can.id);
    const missing = randomUUID();

    const result = await bulkApprove(db, { ids: [bowls.id, planter.id, can.id, missing, bowls.id] });
    expect(result.approved).toBe(1);
    expect(result.alreadyApproved).toBe(0);
    expect(result.skipped).toEqual([
      { id: planter.id, title: "Hand-thrown Terracotta Planter", reason: "SKU TC-PL-30 has no price. Add the price in the sheet and upload it again, then approve" },
      { id: can.id, title: "Watering Can", reason: "This product is deleted. Restore it first" },
      { id: missing, title: null, reason: "Product not found" },
    ]);
    expect(await bulkApprove(db, { ids: [bowls.id] })).toEqual({ approved: 0, alreadyApproved: 1, skipped: [] });

    // Every "ready" product of the import
    const ready = await db.select().from(products).where(and(eq(products.lastImportId, importId), eq(products.status, "ready")));
    expect((await bulkApprove(db, { importId })).approved).toBe(ready.length);
    expect((await list({ status: "ready" })).total).toBe(0);
  });
});

describe("deleting and restoring", () => {
  it("hides a deleted product but keeps it, and restores it as it was, translations queued again", async () => {
    await importAndBuild(SAMPLE);
    const bowls = await byTitle("Bamboo Bowl Set");
    await approveProduct(db, bowls.id);
    // A translation was waiting (taken by a job) when the product was deleted
    await db.insert(translationState).values({ productId: bowls.id, locale: "de", status: "pending", queuedAt: new Date() });
    await setShopLanguages(db, true);

    expect(await deleteProduct(db, bowls.id)).toMatchObject({ alreadyDeleted: false });
    expect(await deleteProduct(db, bowls.id)).toMatchObject({ alreadyDeleted: true });
    expect((await list({ pageSize: "100" })).products.map((p) => p.id)).not.toContain(bowls.id);
    expect((await list({ deleted: "true" })).products.map((p) => p.id)).toEqual([bowls.id]);
    expect((await productDetail(db, bowls.id))!.deletedAt).not.toBeNull();

    const restored = await restoreProduct(db, boss, bowls.id);
    expect(restored).toMatchObject({ restored: true, product: { status: "approved", deletedAt: null } });
    const jobs = await boss.findJobs<TranslateBatchJob>(queues.translateBatch.name);
    expect(jobs.map((j) => j.data.productIds)).toEqual([[bowls.id]]);
    expect((await restoreProduct(db, boss, bowls.id)).restored).toBe(false);
    await expect(restoreProduct(db, boss, randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});
