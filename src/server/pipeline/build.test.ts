import { readFileSync, rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mockProvider, resetMockState } from "@/server/ai/mock";
import { AiPermanentError, type AiProvider } from "@/server/ai/provider";
import { createDb } from "@/server/db/client";
import { AiPausedError } from "@/server/ai/rate-limit";
import { aiCalls, aiStatus, importRows, imports, products, variants } from "@/server/db/schema";
import { env } from "@/server/env";
import { getImportSummary } from "@/server/imports/queries";
import type { BuildBatchJob } from "@/server/queue/queues";
import { createTestImport, setShopLanguages } from "@/test/fixtures";
import { testDatabaseUrl } from "@/test/global-setup";
import { OUT_OF_CREDIT } from "@/server/ai/ask";
import { PROMPT_VERSION } from "@/server/ai/prompt";
import { runBuildBatch } from "./build";
import { runParseImport } from "./run-parse-import";

const db = createDb(testDatabaseUrl());
const SAMPLE = "samples/catalogforge_test_sheet.csv";

beforeEach(async () => {
  await db.execute(sql`truncate imports, products, ai_cache, ai_calls, ai_status restart identity cascade`);
  delete process.env.MOCK_AI_MODE;
  resetMockState();
  // Translations are tested on their own (translations/translations.test.ts)
  await setShopLanguages(db, false);
});

afterAll(async () => {
  await db.$client.end();
  rmSync(env().STORAGE_DIR, { recursive: true, force: true });
});

// Runs the whole import like the worker does, but without the queue: parse, then every AI batch
async function importAndBuild(file: string, bytes?: Uint8Array, provider: AiProvider = mockProvider) {
  const id = await createTestImport(db, file, bytes);
  const queued: BuildBatchJob[] = [];
  await runParseImport(db, id, { enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)) });
  for (const job of queued) await runBuildBatch(db, provider, job);
  return { id, queued };
}

async function getImport(id: string) {
  const [row] = await db.select().from(imports).where(eq(imports.id, id));
  return row;
}

async function productByTitle(title: string) {
  const [row] = await db.select().from(products).where(eq(products.title, title));
  return row;
}

async function rowStatusCounts(id: string) {
  const rows = await db.select({ status: importRows.status }).from(importRows).where(eq(importRows.importId, id));
  return rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
}

describe("the AI step", () => {
  it("builds every product, gives every row a final status, and finishes the import", async () => {
    const { id, queued } = await importAndBuild(SAMPLE);

    expect(queued.length).toBeGreaterThan(0);
    expect(await getImport(id)).toMatchObject({ status: "done", stage: "build" });
    const counts = await rowStatusCounts(id);
    expect(counts.pending).toBeUndefined();
    expect((counts.done ?? 0) + (counts.needs_review ?? 0) + (counts.failed ?? 0)).toBe(18);
    expect(await db.select().from(products)).toHaveLength(12);

    const planter = await productByTitle("Hand-thrown Terracotta Planter");
    expect(planter).toMatchObject({ status: "needs_review", category: "Home & Garden > Planters", handle: "hand-thrown-terracotta-planter" });
    expect(planter.reviewReason).toContain("Row 3: No price");
    expect(planter.claims).toEqual([
      { text: "frost-resistant", source: "catalogforge_test_sheet.csv, row 2, column Notes", quote: "frost-resistant (not frost-proof, bring indoors below 0 °C)" },
    ]);
    const planterVariants = await db.select().from(variants).where(eq(variants.productId, planter.id));
    expect(planterVariants.map((v) => [v.sku, v.priceCents, v.currency]).sort()).toEqual([
      ["TC-PL-20", 2499, "EUR"],
      ["TC-PL-30", null, null],
      ["TC-PL-40", 3990, "EUR"],
    ]);

    // MG-01 is on two rows with different prices: we never pick one, the merchant enters it in Edit
    const mug = await productByTitle("Stoneware Mug");
    expect(mug.reviewReason).toContain("Rows 4 and 5 have the same SKU MG-01 but different prices (€12.50 vs €14.00). Enter the right one with Edit");
    expect(await db.select().from(variants).where(eq(variants.productId, mug.id))).toEqual([
      expect.objectContaining({ sku: "MG-01", priceCents: null, currency: null }),
    ]);

    const bowls = await productByTitle("Bamboo Bowl Set");
    expect(bowls.status).toBe("ready");
  });

  it("saves a SKU that's on two rows with different prices without a price, with the first row's other values", async () => {
    const csv = "SKU,Name,Weight,Price,Currency\nCW-15,Copper Watering Can,1.1 kg,32.00,EUR\nCW-15,Copper Watering Can,1.3 kg,36.00,EUR\n";
    await importAndBuild("cans.csv", new TextEncoder().encode(csv));
    const can = await productByTitle("Copper Watering Can");
    expect(can.status).toBe("needs_review");
    expect(can.reviewReason).toContain("Rows 2 and 3 have the same SKU CW-15 but different prices (€32.00 vs €36.00). Enter the right one with Edit");
    expect(can.reviewReason).toContain("Rows 2 and 3 have the same SKU CW-15 but different weight (1100 g vs 1300 g)");
    const saved = await db.select().from(variants).where(eq(variants.productId, can.id));
    expect(saved.map((v) => [v.sku, v.priceCents, v.currency, v.weightGrams])).toEqual([["CW-15", null, null, 1100]]);

    // Rows without a SKU are the same variant when their options are the same
    await importAndBuild("benches.csv", new TextEncoder().encode("Name,Price\nGarden Bench,120\nGarden Bench,130\n"));
    const bench = await productByTitle("Garden Bench");
    expect(bench.reviewReason).toContain("Rows 2 and 3 have no SKU and the same size, colour and options but different prices (€120.00 vs €130.00)");
    expect(await db.select().from(variants).where(eq(variants.productId, bench.id))).toEqual([expect.objectContaining({ priceCents: null })]);
  });

  it("writes a listing again when it was written with older instructions, even if the sheet hasn't changed", async () => {
    await importAndBuild(SAMPLE);
    await db.update(products).set({ promptVersion: "build-old" });
    // Same sheet: without the version check every product would be kept as it is (nothing new to say)
    const again = await importAndBuild(SAMPLE);
    expect(again.queued.length).toBeGreaterThan(0);
    expect(again.queued.every((j) => !j.keepListing)).toBe(true);
    expect(new Set((await db.select().from(products)).map((p) => p.promptVersion))).toEqual(new Set([PROMPT_VERSION]));
  });

  it("saves a colour column that really holds scents as 'scent', and keeps that name when a price list comes back", async () => {
    const csv = [
      "SKU,Parent SKU,Name,Description,Colour,Price,Currency",
      "SC-LAV,SC,Soy Candle,Soy wax candle in an amber glass jar.,Lavender,18.00,EUR",
      "SC-CED,SC,Soy Candle,Soy wax candle in an amber glass jar.,Cedar,18.00,EUR",
    ].join("\n");
    await importAndBuild("candles.csv", new TextEncoder().encode(csv));
    const candle = await productByTitle("Soy Candle");
    expect(candle.optionNames).toEqual({ color: "scent" });
    const options = async () => Object.fromEntries((await db.select().from(variants).where(eq(variants.productId, candle.id))).map((v) => [v.sku, v.options]));
    expect(await options()).toEqual({ "SC-LAV": { scent: "lavender" }, "SC-CED": { scent: "cedar" } });

    // A price list for the same SKUs: no AI call, and the variants don't get a "color" back next to "scent"
    const second = await importAndBuild("prices.csv", new TextEncoder().encode("SKU,Colour,Price,Currency\nSC-LAV,Lavender,19.00,EUR\nSC-CED,Cedar,19.00,EUR\n"));
    expect(second.queued.map((j) => j.keepListing)).toEqual([true]);
    expect(await options()).toEqual({ "SC-LAV": { scent: "lavender" }, "SC-CED": { scent: "cedar" } });
  });

  it("keeps a price the merchant set by hand when the sheet comes back, and drops the sheet's price problems for it", async () => {
    await importAndBuild(SAMPLE);
    // As if typed in Edit (see products.test.ts)
    await db.update(variants).set({ priceCents: 2950, currency: "EUR", priceSetByHand: true }).where(eq(variants.sku, "TC-PL-30"));
    const prices = async () => Object.fromEntries((await db.select().from(variants).where(sql`${variants.sku} like 'TC-PL-%'`)).map((v) => [v.sku, v.priceCents]));

    // A new price for TC-PL-20 only (the listing is kept). Row 3 still has no price, but the merchant's counts
    const sheet = readFileSync(SAMPLE, "utf8").replaceAll('"24,99 €"', '"25,99 €"');
    const second = await importAndBuild(SAMPLE, new TextEncoder().encode(sheet));
    expect(second.queued.map((j) => j.keepListing)).toEqual([true]);
    expect(await prices()).toEqual({ "TC-PL-20": 2599, "TC-PL-30": 2950, "TC-PL-40": 3990 });
    expect((await productByTitle("Hand-thrown Terracotta Planter")).reviewReason ?? "").not.toContain("No price");

    // New text (the AI writes the listing again) and the sheet's own price for TC-PL-30: the merchant's still wins
    const rewritten = sheet.replace("3.1kg,,,", "3.1kg,31.00,EUR,").replaceAll("with drainage hole", "with a drainage hole");
    const third = await importAndBuild(SAMPLE, new TextEncoder().encode(rewritten));
    expect(third.queued.map((j) => j.keepListing)).toEqual([undefined]);
    expect(await prices()).toEqual({ "TC-PL-20": 2599, "TC-PL-30": 2950, "TC-PL-40": 3990 });
    const [handSet] = await db.select().from(variants).where(eq(variants.sku, "TC-PL-30"));
    expect(handSet.priceSetByHand).toBe(true);
  });

  it("leaves updatedAt alone when a re-upload changes nothing about a product, and moves it when it does", async () => {
    await importAndBuild(SAMPLE);
    const variantTimes = async () => Object.fromEntries((await db.select().from(variants)).map((v) => [v.sku, v.updatedAt.getTime()]));
    const variantsBefore = await variantTimes();

    // The same sheet again: no variant is written
    await importAndBuild(SAMPLE);
    expect(await variantTimes()).toEqual(variantsBefore);

    // A price list with the same price: the bowls now belong to this upload, but nothing the merchant sees changed
    const bowls = await productByTitle("Bamboo Bowl Set");
    const same = await importAndBuild("prices.csv", new TextEncoder().encode("SKU,Name,Price,Currency\nBW-SET,Bamboo Bowl Set,24.00,EUR\n"));
    expect(same.queued.map((j) => j.keepListing)).toEqual([true]);
    expect(await productByTitle("Bamboo Bowl Set")).toMatchObject({ lastImportId: same.id, updatedAt: bowls.updatedAt });
    expect(await variantTimes()).toEqual(variantsBefore);

    // A new price is a real change
    await importAndBuild("prices.csv", new TextEncoder().encode("SKU,Name,Price,Currency\nBW-SET,Bamboo Bowl Set,26.00,EUR\n"));
    expect((await productByTitle("Bamboo Bowl Set")).updatedAt.getTime()).toBeGreaterThan(bowls.updatedAt.getTime());
    expect((await variantTimes())["BW-SET"]).toBeGreaterThan(variantsBefore["BW-SET"]);
  });

  // An unchanged product never reaches build.ts: planStage (run-parse-import.ts) moves it to the new upload
  it("leaves every product's updatedAt alone when the same sheet is uploaded again", async () => {
    await importAndBuild(SAMPLE);
    const times = async () => Object.fromEntries((await db.select().from(products)).map((p) => [p.id, p.updatedAt.getTime()]));
    const before = await times();
    await importAndBuild(SAMPLE);
    expect(await times()).toEqual(before);
  });

  it("keeps instructions hidden in supplier text away from the AI and out of the claims", async () => {
    await importAndBuild(SAMPLE);
    const candle = await productByTitle("Scented Soy Candle");
    expect(candle.claims).toEqual([]);
    expect(candle.reviewReason).toContain("Text looks like instructions for an AI");
  });

  it("removes claims the AI invents and flags descriptions that make them", async () => {
    process.env.MOCK_AI_MODE = "invent";
    await importAndBuild(SAMPLE);
    const planter = await productByTitle("Hand-thrown Terracotta Planter");
    expect(planter.claims.map((c) => c.text)).toEqual(["frost-resistant"]);
    expect(planter.reviewReason).toContain('Removed claim "dishwasher-safe"');
    expect(planter.reviewReason).toContain('Removed claim "frost-proof": the supplier says it isn\'t');
    expect(planter.reviewReason).toContain('The description says "dishwasher safe", but the supplier never says that');
  });

  it("splits a batch whose answer was cut off and still builds every product", async () => {
    process.env.MOCK_AI_MODE = "truncate";
    const { id } = await importAndBuild(SAMPLE);
    expect(await getImport(id)).toMatchObject({ status: "done" });
    expect(await db.select().from(products)).toHaveLength(12);
    const cut = await db.select().from(aiCalls).where(eq(aiCalls.status, "invalid_output"));
    expect(cut.map((c) => c.error)).toContain("Answer cut off at the output limit");
  });

  it("asks again after broken JSON", async () => {
    process.env.MOCK_AI_MODE = "badjson";
    const { id } = await importAndBuild(SAMPLE);
    expect(await getImport(id)).toMatchObject({ status: "done" });
    const calls = await db.select().from(aiCalls);
    expect(calls.some((c) => c.status === "invalid_output" && c.error === "Not valid JSON")).toBe(true);
    expect(await db.select().from(products)).toHaveLength(12);
  });

  it("reuses the saved AI answer when a batch runs again after a crash, without duplicating anything", async () => {
    const { id, queued } = await importAndBuild(SAMPLE);
    const productsBefore = await db.select().from(products);
    const variantsBefore = await db.select().from(variants);

    // Pretend the worker crashed after asking the AI but before saving: rows are waiting again
    await db.update(importRows).set({ status: "pending" }).where(and(eq(importRows.importId, id), sql`${importRows.status} <> 'failed'`));
    await db.update(imports).set({ status: "running" }).where(eq(imports.id, id));
    for (const job of queued) await runBuildBatch(db, mockProvider, job);

    expect(await db.select().from(products)).toHaveLength(productsBefore.length);
    expect(await db.select().from(variants)).toHaveLength(variantsBefore.length);
    const fromCache = await db.select().from(aiCalls).where(eq(aiCalls.fromCache, true));
    expect(fromCache).toHaveLength(queued.length);
    expect(await getImport(id)).toMatchObject({ status: "done" });
    // Saved again with the same answer: nothing changed, so nothing looks just updated
    const times = (rows: { id: string; updatedAt: Date }[]) => Object.fromEntries(rows.map((r) => [r.id, r.updatedAt.getTime()]));
    expect(times(await db.select().from(products))).toEqual(times(productsBefore));
    expect(times(await db.select().from(variants))).toEqual(times(variantsBefore));
  });

  it("makes no AI calls when the same file is uploaded again", async () => {
    await importAndBuild(SAMPLE);
    const callsBefore = (await db.select().from(aiCalls)).length;

    const second = await importAndBuild(SAMPLE);
    expect(second.queued).toEqual([]);
    expect(await getImport(second.id)).toMatchObject({ status: "done" });
    expect(await db.select().from(aiCalls)).toHaveLength(callsBefore);
    expect(await db.select().from(products)).toHaveLength(12);
    // The unchanged products show up under the new upload too
    expect((await db.select().from(products)).map((p) => p.lastImportId)).toEqual(Array(12).fill(second.id));
  });

  it("never overwrites a field the merchant edited by hand", async () => {
    const csv = (description: string) => new TextEncoder().encode(`SKU,Name,Description,Price\nA-1,Garden Bench,"${description}",120\n`);
    await importAndBuild("bench.csv", csv("Oak bench."));
    await db.update(products).set({ title: "Our favourite bench", merchantEditedFields: ["title"] });

    await importAndBuild("bench.csv", csv("Solid oak bench, oiled."));
    const [bench] = await db.select().from(products);
    expect(bench.title).toBe("Our favourite bench");
    expect(bench.descriptionHtml).toContain("Solid oak bench, oiled.");
  });

  it("updates the existing product when the same SKUs come from a differently laid out file", async () => {
    await importAndBuild(SAMPLE);
    await importAndBuild("samples/test-files/03-messy-layout/supplier_price_list_2026.xlsx");

    const planters = await db.select().from(products).where(sql`${products.title} ilike '%terracotta planter%'`);
    expect(planters).toHaveLength(1);
    expect(planters[0].reviewReason ?? "").not.toContain("already belongs to another product");
    const skus = await db.select().from(variants).where(eq(variants.productId, planters[0].id));
    expect(skus.map((v) => v.sku).sort()).toEqual(["TC-PL-20", "TC-PL-30", "TC-PL-40"]);
  });

  it("keeps a richer listing when a later price list has nothing new to say, and only updates the prices", async () => {
    await importAndBuild(SAMPLE);
    const callsBefore = (await db.select().from(aiCalls)).length;
    const before = await productByTitle("Hand-thrown Terracotta Planter");

    const priceList =
      "SKU,Name,Size,Price,Currency\nTC-PL-20,Terracotta Planter,20 cm,26.00,EUR\nTC-PL-30,Terracotta Planter,30 cm,31.00,EUR\nTC-PL-40,Terracotta Planter,40 cm,41.00,EUR\n";
    const second = await importAndBuild("price_list.csv", new TextEncoder().encode(priceList));

    expect(second.queued.map((j) => j.keepListing)).toEqual([true]);
    expect(await db.select().from(aiCalls)).toHaveLength(callsBefore);
    const after = await productByTitle("Hand-thrown Terracotta Planter");
    expect(after).toMatchObject({ id: before.id, descriptionHtml: before.descriptionHtml, claims: before.claims, lastImportId: second.id, status: "ready" });
    // New prices. The colour and weight the price list doesn't have are kept from the first sheet
    const saved = await db.select().from(variants).where(eq(variants.productId, after.id)).orderBy(variants.sku);
    expect(saved.map((v) => [v.sku, v.priceCents, v.options.color, v.weightGrams])).toEqual([
      ["TC-PL-20", 2600, "terracotta", 1800],
      ["TC-PL-30", 3100, "terracotta", 3100],
      ["TC-PL-40", 4100, "terracotta", 5200],
    ]);
    const rows = await db.select().from(importRows).where(eq(importRows.importId, second.id));
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "done"]);
    expect(rows[0].reason).toContain("The listing was kept");
    expect(await getImport(second.id)).toMatchObject({ status: "done" });
  });

  it("still flags a variant from an earlier upload that has no price, when the new file leaves it out", async () => {
    await importAndBuild(SAMPLE);
    await importAndBuild("price_list.csv", new TextEncoder().encode("SKU,Name,Price\nTC-PL-20,Terracotta Planter,26.00\n"));
    const planter = await productByTitle("Hand-thrown Terracotta Planter");
    expect(planter.status).toBe("needs_review");
    expect(planter.reviewReason).toContain("SKU TC-PL-30 still has no price (from an earlier upload)");
  });

  it("rewrites the listing when the new file has its own description", async () => {
    await importAndBuild(SAMPLE);
    const callsBefore = (await db.select().from(aiCalls)).length;
    const second = await importAndBuild("new.csv", new TextEncoder().encode("SKU,Name,Description,Price\nTC-PL-20,Terracotta Planter,Plain terracotta pot.,26.00\n"));
    expect(second.queued.map((j) => j.keepListing)).toEqual([undefined]);
    expect((await db.select().from(aiCalls)).length).toBeGreaterThan(callsBefore);
    const [planter] = await db.select().from(products).where(eq(products.lastImportId, second.id));
    expect(planter.descriptionHtml).toContain("Plain terracotta pot.");
  });

  it("only updates the price, without an AI call, when the same sheet comes back with a new price", async () => {
    await importAndBuild(SAMPLE);
    const callsBefore = (await db.select().from(aiCalls)).length;
    const bowlsBefore = await productByTitle("Bamboo Bowl Set");

    const changed = readFileSync(SAMPLE, "utf8").replace("EUR 24", "EUR 26");
    const second = await importAndBuild(SAMPLE, new TextEncoder().encode(changed));

    expect(second.queued).toEqual([expect.objectContaining({ keepListing: true, productKeys: [expect.stringContaining("bw-set")] })]);
    expect(await db.select().from(aiCalls)).toHaveLength(callsBefore);
    const bowls = await productByTitle("Bamboo Bowl Set");
    expect(bowls.descriptionHtml).toBe(bowlsBefore.descriptionHtml);
    const [variant] = await db.select().from(variants).where(eq(variants.productId, bowls.id));
    expect(variant.priceCents).toBe(2600);
  });

  it("never brings back a deleted product, even when a differently laid out file has its SKUs", async () => {
    await importAndBuild(SAMPLE);
    const planter = await productByTitle("Hand-thrown Terracotta Planter");
    await db.update(products).set({ deletedAt: new Date() }).where(eq(products.id, planter.id));

    const second = await importAndBuild("new.csv", new TextEncoder().encode("SKU,Name,Description,Price\nTC-PL-20,Terracotta Planter,Plain terracotta pot.,26.00\n"));
    const [after] = await db.select().from(products).where(eq(products.id, planter.id));
    expect(after).toMatchObject({ title: "Hand-thrown Terracotta Planter", deletedAt: expect.any(Date) });
    const rows = await db.select().from(importRows).where(eq(importRows.importId, second.id));
    expect(rows.map((r) => [r.status, r.reason])).toEqual([["done", "Skipped: you deleted this product. Restore it to import it again"]]);
    const [variant] = await db.select().from(variants).where(eq(variants.sku, "TC-PL-20"));
    expect(variant.priceCents).toBe(2499);
  });

  it("keeps an approved product approved when only its price changes, but not when the AI writes new English", async () => {
    await importAndBuild(SAMPLE);
    const bowls = await productByTitle("Bamboo Bowl Set");
    const approvedAt = new Date("2026-10-20T10:00:00Z");
    await db.update(products).set({ status: "approved", approvedAt }).where(eq(products.id, bowls.id));

    await importAndBuild(SAMPLE, new TextEncoder().encode(readFileSync(SAMPLE, "utf8").replace("EUR 24", "EUR 26")));
    expect(await productByTitle("Bamboo Bowl Set")).toMatchObject({ status: "approved", approvedAt });

    const newText = readFileSync(SAMPLE, "utf8").replace("EUR 24", "EUR 26").replace("Set of 4 bamboo bowls.", "Set of 4 oiled bamboo bowls.");
    await importAndBuild(SAMPLE, new TextEncoder().encode(newText));
    expect(await productByTitle("Bamboo Bowl Set")).toMatchObject({ status: "ready", approvedAt: null });
  });

  it("updates the product but asks for a check when the same SKU now has a very different name", async () => {
    await importAndBuild("first.csv", new TextEncoder().encode("SKU,Name,Price\nX-1,Blue Vase,20\n"));
    await importAndBuild("second.csv", new TextEncoder().encode("SKU,Name,Parent SKU,Price\nX-1,Red Lamp,LAMP,30\n"));
    const all = await db.select().from(products);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("needs_review");
    expect(all[0].reviewReason).toContain('These SKUs belonged to "Blue Vase", which is now called "Red Lamp"');
  });

  it("flags a real SKU conflict: one product whose SKUs belong to two different products", async () => {
    await importAndBuild("first.csv", new TextEncoder().encode("SKU,Name,Price\nX-1,Blue Vase,20\nY-1,Red Lamp,30\n"));
    await importAndBuild("second.csv", new TextEncoder().encode("SKU,Name,Parent SKU,Size,Price\nX-1,Table Set,SET,S,20\nY-1,Table Set,SET,L,30\n"));
    const set = await productByTitle("Table Set");
    expect(set.status).toBe("needs_review");
    expect(set.reviewReason).toContain("SKU X-1 already belongs to another product");
    expect(set.reviewReason).toContain("SKU Y-1 already belongs to another product");
  });

  it("gives products with the same name different web addresses, even when batches run at the same time", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `DM-${i},DM-P${i},Doormat,${10 + i}`);
    const id = await createTestImport(db, "doormats.csv", new TextEncoder().encode(`SKU,Parent SKU,Name,Price\n${lines.join("\n")}\n`));
    const queued: BuildBatchJob[] = [];
    await runParseImport(db, id, { enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)) });
    expect(queued.length).toBe(4);

    await Promise.all(queued.map((job) => runBuildBatch(db, mockProvider, job)));

    const handles = (await db.select({ handle: products.handle }).from(products)).map((p) => p.handle);
    expect(new Set(handles).size).toBe(40);
    expect(handles).toContain("doormat");
    expect(await getImport(id)).toMatchObject({ status: "done" });
  });

  it("answers a retried batch from the cache, even when part of it was already saved", async () => {
    const { id, queued } = await importAndBuild(SAMPLE);
    const callsBefore = await db.select().from(aiCalls);

    // Pretend the first try saved only some products before crashing
    const [someKey] = queued[0].productKeys;
    await db.update(importRows).set({ status: "pending" }).where(and(eq(importRows.importId, id), eq(importRows.productKey, someKey)));
    await db.update(imports).set({ status: "running" }).where(eq(imports.id, id));
    await runBuildBatch(db, mockProvider, queued[0]);

    const newCalls = (await db.select().from(aiCalls)).slice(callsBefore.length);
    expect(newCalls.map((c) => c.fromCache)).toEqual([true]);
    expect(await getImport(id)).toMatchObject({ status: "done" });
  });

  it("pauses on 'too many requests', waits, then carries on without a failed try", async () => {
    process.env.MOCK_AI_MODE = "ratelimit";
    const started = Date.now();
    const { id } = await importAndBuild(SAMPLE);
    expect(await getImport(id)).toMatchObject({ status: "done" });
    // The mock asks to wait 2 seconds
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    const statuses = (await db.select().from(aiCalls)).map((c) => c.status);
    expect(statuses).toContain("rate_limited");
    expect(await db.select().from(products)).toHaveLength(12);
  });

  it("asks again when the AI copies German text instead of translating, then sends it to review if it still does", async () => {
    process.env.MOCK_AI_MODE = "notranslate";
    await importAndBuild("samples/test-files/02-german/artikel_de.xlsx");
    const scissors = await productByTitle("Kräuterschere");
    expect(scissors.status).toBe("needs_review");
    expect(scissors.reviewReason).toContain('Not translated into English: the AI copied the supplier\'s title "Kräuterschere"');
    // The batch was asked once, then the untranslated products once more
    const calls = await db.select().from(aiCalls);
    expect(calls.length).toBe(2);
  });

  it("accepts translated German products", async () => {
    await importAndBuild("samples/test-files/02-german/artikel_de.xlsx");
    const all = await db.select().from(products);
    expect(all.every((p) => !(p.reviewReason ?? "").includes("Not translated"))).toBe(true);
    expect(await db.select().from(aiCalls)).toHaveLength(1);
  });

  it("pauses the import when the AI account is out of credit, fails nothing, and finishes after a top-up", async () => {
    process.env.MOCK_AI_MODE = "nocredit:1";
    const id = await createTestImport(db, SAMPLE);
    const queued: BuildBatchJob[] = [];
    await runParseImport(db, id, { enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)) });

    // The first batch finds the account empty: the import pauses and the batch goes back to the queue
    const first = await runBuildBatch(db, mockProvider, queued[0]).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(AiPausedError);
    expect((first as AiPausedError).message).toBe(OUT_OF_CREDIT);
    // The other batches don't call the AI while it's paused, they wait too
    const second = await runBuildBatch(db, mockProvider, queued[1]).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(AiPausedError);
    expect(await getImportSummary(db, id)).toMatchObject({ status: "paused", pauseReason: OUT_OF_CREDIT });
    expect(await db.select().from(importRows).where(and(eq(importRows.importId, id), eq(importRows.status, "failed")))).toEqual([]);

    // Topped up, and the pause is over: the batches run again and the import finishes
    await db.update(aiStatus).set({ pausedUntil: new Date(), nextCallAt: new Date() });
    for (const job of queued) await runBuildBatch(db, mockProvider, job);
    expect(await getImport(id)).toMatchObject({ status: "done" });
    expect(await db.select().from(products)).toHaveLength(12);
    expect(await db.select().from(importRows).where(and(eq(importRows.importId, id), eq(importRows.status, "failed")))).toEqual([]);
  });

  it("fails the products, not the whole import, when the AI provider refuses the request", async () => {
    const refusing: AiProvider = {
      name: "refusing",
      modelFor: () => "refusing-model",
      generate: async () => {
        throw new AiPermanentError("API key not valid");
      },
    };
    const { id } = await importAndBuild(SAMPLE, undefined, refusing);
    expect(await getImport(id)).toMatchObject({ status: "done" });
    const failed = await db.select().from(importRows).where(and(eq(importRows.importId, id), eq(importRows.status, "failed")));
    expect(failed).toHaveLength(18);
    expect(failed[0].reason).toBe("The AI provider refused the request: API key not valid");
  });
});
