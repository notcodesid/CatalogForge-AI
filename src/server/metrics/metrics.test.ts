import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costMicroUsd } from "@/server/ai/pricing";
import { createDb } from "@/server/db/client";
import { aiCalls, importRows, imports, products, translations } from "@/server/db/schema";
import { testDatabaseUrl } from "@/test/global-setup";
import { getMetrics } from "./metrics";
import { instructionTokens } from "./savings";
import { metricsWindow, windowQuery } from "./window";

const db = createDb(testDatabaseUrl());

const offPeak = new Date("2026-10-24T12:00:00Z"); // a Saturday
const peak = new Date("2026-10-22T07:00:00Z"); // a Thursday, 07:00 UTC
const longAgo = new Date("2026-09-01T12:00:00Z");
const usd = (micro: number) => Math.round(micro) / 1_000_000;

// What each paid call cost, worked out the same way the app records it
const u1 = { inputTokens: 10_000, outputTokens: 2_000, cachedInputTokens: 6_000 };
const u2 = { inputTokens: 20_000, outputTokens: 4_000 };
const u3 = { inputTokens: 5_000, outputTokens: 3_000 };
const u6 = { inputTokens: 15_000, outputTokens: 1_000 };
const u10 = { inputTokens: 8_000, outputTokens: 2_000 };
const c1 = costMicroUsd("deepseek-flash", u1, offPeak);
const c2 = costMicroUsd("deepseek-v4-pro", u2, peak);
const c3 = costMicroUsd("deepseek-flash", u3, offPeak);
const c6 = costMicroUsd("deepseek-v4-pro", u6, peak);
const c10 = costMicroUsd("deepseek-v4-pro", u10, longAgo);

let a = "";
let b = "";

beforeAll(async () => {
  await db.execute(sql`truncate imports, products, ai_calls, ai_cache, ai_status restart identity cascade`);

  [{ id: a }, { id: b }] = await db
    .insert(imports)
    .values([
      { sheetFileName: "a.csv", status: "done", createdAt: new Date("2026-10-21T10:00:00Z"), startedAt: new Date("2026-10-21T10:00:00Z"), finishedAt: new Date("2026-10-21T10:02:00Z") },
      { sheetFileName: "b.csv", status: "done", createdAt: new Date("2026-10-22T07:00:00Z"), startedAt: new Date("2026-10-22T07:00:00Z"), finishedAt: new Date("2026-10-22T07:10:00Z") },
      { sheetFileName: "c.csv", status: "failed", createdAt: new Date("2026-10-23T09:00:00Z") },
    ])
    .returning({ id: imports.id });
  const [{ id: old }] = await db.insert(imports).values({ sheetFileName: "old.csv", status: "done", createdAt: longAgo }).returning({ id: imports.id });

  const row = (importId: string, rowNumber: number, status: "done" | "needs_review" | "failed", productKey: string) => ({ importId, rowNumber, status, productKey, raw: {}, rowHash: "x" });
  await db.insert(importRows).values([
    // a.csv: 4 rows, 2 products (k3 failed)
    row(a, 2, "done", "k1"),
    row(a, 3, "done", "k1"),
    row(a, 4, "needs_review", "k2"),
    row(a, 5, "failed", "k3"),
    // b.csv: 6 rows, 5 products
    row(b, 2, "done", "p1"),
    row(b, 3, "done", "p2"),
    row(b, 4, "done", "p3"),
    row(b, 5, "done", "p4"),
    row(b, 6, "needs_review", "p5"),
    row(b, 7, "needs_review", "p5"),
    // Outside the period
    row(old, 2, "done", "o1"),
  ]);

  const product = (key: string, status: "ready" | "needs_review" | "approved", extra: object = {}) => ({ productKey: key, handle: key, title: key, status, ...extra });
  const [first] = await db
    .insert(products)
    .values([
      product("k1", "ready", { englishHashes: { title: "new" } }),
      product("k2", "needs_review"),
      product("p1", "ready"),
      product("p2", "approved"),
      product("gone", "ready", { deletedAt: new Date() }),
    ])
    .returning({ id: products.id });
  // The merchant's German title, written before the English changed: out of date
  await db.insert(translations).values({ productId: first.id, locale: "de", field: "title", value: "Titel", sourceHash: "old", writtenBy: "merchant" });

  const call = (fields: Partial<typeof aiCalls.$inferInsert> & Pick<typeof aiCalls.$inferInsert, "model" | "createdAt">) => ({
    purpose: "build",
    provider: "deepseek",
    status: "ok" as const,
    latencyMs: 0,
    productCount: 10,
    ...fields,
  });
  await db.insert(aiCalls).values([
    call({ importId: a, model: "deepseek-flash", ...u1, costMicroUsd: c1, latencyMs: 4_000, createdAt: offPeak }),
    call({ importId: b, model: "deepseek-v4-pro", ...u2, costMicroUsd: c2, latencyMs: 9_000, productCount: 5, createdAt: peak }),
    call({ importId: a, model: "deepseek-flash", purpose: "translate", ...u3, costMicroUsd: c3, latencyMs: 3_000, createdAt: offPeak }),
    // Answered from a saved answer
    call({ importId: a, model: "deepseek-flash", fromCache: true, createdAt: offPeak }),
    call({ importId: a, model: "deepseek-flash", status: "rate_limited", latencyMs: 100, createdAt: offPeak }),
    call({ importId: b, model: "deepseek-v4-pro", status: "invalid_output", ...u6, costMicroUsd: c6, latencyMs: 8_000, productCount: 5, createdAt: peak }),
    call({ importId: a, model: "deepseek-flash", status: "timeout", latencyMs: 90_000, createdAt: offPeak }),
    // Outside the period
    call({ model: "deepseek-flash", ...u1, costMicroUsd: 999_999, createdAt: longAgo }),
    // A saved answer of a kind the period has no paid call of: priced from all time (the call below)
    call({ model: "deepseek-v4-pro", purpose: "translate", fromCache: true, productCount: 4, createdAt: peak }),
    call({ model: "deepseek-v4-pro", purpose: "translate", ...u10, costMicroUsd: c10, productCount: 8, createdAt: longAgo }),
  ]);
});

afterAll(async () => {
  await db.$client.end();
});

async function metrics() {
  const window = metricsWindow(windowQuery.parse({ from: "2026-10-17", to: "2026-10-25" }));
  if ("error" in window) throw new Error(window.error);
  return getMetrics(db, window);
}

describe("getMetrics", () => {
  it("counts the period's products and rows, and the catalog as it is now", async () => {
    const m = await metrics();
    expect(m.window).toEqual({ from: "2026-10-17T00:00:00.000Z", to: "2026-10-25T00:00:00.000Z", bucket: "day" });
    expect(m.products).toEqual({
      processed: 7,
      catalog: { total: 4, ready: 2, needsReview: 1, approved: 1, deleted: 1 },
      rates: { ready: 50, needsReview: 25, approved: 25 },
    });
    expect(m.rows).toEqual({ total: 10, done: 6, needsReview: 3, failed: 1, pending: 0, rates: { done: 60, needsReview: 30, failed: 10 } });
  });

  it("reports each import's speed and cost, the average and the slowest", async () => {
    const { imports: i } = await metrics();
    expect(i.total).toBe(3);
    expect(i.byStatus).toMatchObject({ done: 2, failed: 1, running: 0 });
    expect(i.speed).toEqual({ averageSeconds: 360, rowsPerMinute: 0.8, slowest: { id: b, fileName: "b.csv", rows: 6, seconds: 600 } });
    expect(i.recent.map((r) => r.fileName)).toEqual(["c.csv", "b.csv", "a.csv"]);
    expect(i.recent[2]).toMatchObject({ rows: 4, products: 2, seconds: 120, rowsPerMinute: 2, aiCalls: 5, costUsd: usd(c1 + c3), costPerProductUsd: usd((c1 + c3) / 2) });
    expect(i.topByCost.map((r) => r.id)).toEqual([b, a]);
  });

  it("breaks the AI's work down by model, kind and day, with speed and problems", async () => {
    const { ai } = await metrics();
    expect(ai).toMatchObject({
      calls: 8,
      cacheHits: 2,
      inputTokens: 50_000,
      outputTokens: 10_000,
      costUsd: usd(c1 + c2 + c3 + c6),
      // The imports' AI cost over the 7 products they wrote
      costPerProductUsd: usd((c1 + c2 + c3 + c6) / 7),
      problems: { rateLimited: 1, timeout: 1, invalidOutput: 1, error: 0 },
    });
    const flash = ai.byModel.find((m) => m.model === "deepseek-flash")!;
    expect(flash).toMatchObject({ calls: 5, cacheHits: 1, products: 40, costUsd: usd(c1 + c3), averageLatencyMs: 3_500, slowestLatencyMs: 4_000 });
    expect(ai.byModel.find((m) => m.model === "deepseek-v4-pro")).toMatchObject({ calls: 3, cacheHits: 1, products: 10, costUsd: usd(c2 + c6), averageLatencyMs: 9_000 });
    expect(ai.byPurpose.map((p) => [p.purpose, p.calls])).toEqual(expect.arrayContaining([["build", 6], ["translate", 2]]));
    expect(ai.overTime).toHaveLength(8);
    expect(ai.overTime.find((d) => d.at === "2026-10-22T00:00:00.000Z")).toEqual({ at: "2026-10-22T00:00:00.000Z", calls: 3, inputTokens: 35_000, outputTokens: 5_000, costUsd: usd(c2 + c6) });
    expect(ai.overTime.find((d) => d.at === "2026-10-19T00:00:00.000Z")).toMatchObject({ calls: 0, costUsd: 0 });
  });

  it("estimates the money saved by routing, batching and saved answers", async () => {
    const { savings } = await metrics();
    // Routing: the cheap model's paid calls, priced at the strong model
    const routing = costMicroUsd("deepseek-v4-pro", u1, offPeak) - c1 + (costMicroUsd("deepseek-v4-pro", u3, offPeak) - c3);
    expect(savings.routing.calls).toBe(2);
    expect(savings.routing.usd).toBeCloseTo(usd(routing), 5);
    // Batching: instructions sent once per call instead of once per product
    const build = instructionTokens("build");
    const translate = instructionTokens("translate");
    expect(savings.batching.extraInstructionTokens).toBe(9 * build + 9 * translate + 8 * build);
    const batching =
      costMicroUsd("deepseek-flash", { inputTokens: 9 * build, outputTokens: 0, cachedInputTokens: Math.round(0.6 * 9 * build) }, offPeak) +
      costMicroUsd("deepseek-flash", { inputTokens: 9 * translate, outputTokens: 0 }, offPeak) +
      costMicroUsd("deepseek-v4-pro", { inputTokens: 8 * build, outputTokens: 0 }, peak);
    expect(savings.batching.usd).toBeCloseTo(usd(batching), 5);
    // Saved answers: 10 products like call 1, 4 products like the old strong translation
    expect(savings.cache.calls).toBe(2);
    expect(savings.cache.usd).toBeCloseTo(usd(c1 + (4 * c10) / 8), 6);
    expect(savings.totalUsd).toBeCloseTo(savings.routing.usd + savings.batching.usd + savings.cache.usd, 5);
    for (const kind of [savings.cache, savings.routing, savings.batching]) expect(kind.note.length).toBeGreaterThan(20);
  });

  it("reports translation coverage per language and the merchant's out-of-date translations", async () => {
    const { translations: t } = await metrics();
    expect(t.products).toBe(4);
    expect(t.outOfDate).toBe(1);
    expect(t.languages.find((l) => l.locale === "de")).toMatchObject({ enabled: true, merchantFixes: 1, outOfDate: 1 });
  });
});
