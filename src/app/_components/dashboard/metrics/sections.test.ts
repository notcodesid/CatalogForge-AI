import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiSection, CatalogSection, ImportsSection, KeyNumbers, ReviewReasonsSection, TranslationsSection } from "./sections";
import type { Metrics } from "./types";

// The sections rendered to HTML with real-shaped data (no browser here): nothing crashes, the numbers and their
// explanations are there, and an empty period reads cleanly

const busy: Metrics = {
  window: { from: "2026-10-15T12:00:00.000Z", to: "2026-10-22T12:00:00.000Z", bucket: "day" },
  products: { processed: 66, catalog: { total: 37, ready: 16, needsReview: 9, approved: 12, deleted: 2 }, rates: { ready: 43.2, needsReview: 24.3, approved: 32.4 } },
  rows: { total: 105, done: 72, needsReview: 33, failed: 0, pending: 0, rates: { done: 68.6, needsReview: 31.4, failed: 0 } },
  imports: {
    total: 15,
    byStatus: { waiting_for_files: 0, queued: 0, running: 0, paused: 0, done: 11, failed: 4 },
    speed: { averageSeconds: 6, rowsPerMinute: 102.6, slowest: { id: "imp-1", fileName: "catalogforge_test_sheet.csv", rows: 18, seconds: 13.7 } },
    recent: [
      { id: "imp-1", fileName: "catalogforge_test_sheet.csv", status: "done", createdAt: "2026-10-22T11:49:53.361Z", rows: 18, products: 12, seconds: 7.9, rowsPerMinute: 136.7, aiCalls: 6, costUsd: 0.001253, costPerProductUsd: 0.000104 },
      { id: "imp-2", fileName: "empty.csv", status: "failed", createdAt: "2026-10-22T11:40:00.000Z", rows: 0, products: 0, seconds: null, rowsPerMinute: null, aiCalls: 0, costUsd: 0, costPerProductUsd: null },
    ],
    topByCost: [{ id: "imp-1", fileName: "catalogforge_test_sheet.csv", status: "done", createdAt: "2026-10-22T11:49:53.361Z", rows: 18, products: 12, seconds: 7.9, rowsPerMinute: 136.7, aiCalls: 6, costUsd: 0.001253, costPerProductUsd: 0.000104 }],
  },
  ai: {
    calls: 41,
    cacheHits: 11,
    products: 92,
    inputTokens: 29019,
    outputTokens: 11369,
    costUsd: 0.009891,
    costPerProductUsd: 0.00016,
    costPer1000ProductsUsd: 0.159963,
    answeredCalls: 30,
    byModel: [
      { provider: "deepseek", model: "deepseek-flash", calls: 34, cacheHits: 6, products: 90, inputTokens: 26477, outputTokens: 10919, costUsd: 0.008302, costPerProductUsd: 0.000092, averageLatencyMs: 2093, slowestLatencyMs: 5324 },
      { provider: "deepseek", model: "deepseek-v4-pro", calls: 7, cacheHits: 5, products: 2, inputTokens: 2542, outputTokens: 450, costUsd: 0.001589, costPerProductUsd: 0.000795, averageLatencyMs: 4200, slowestLatencyMs: 6100 },
    ],
    byPurpose: [
      { purpose: "translate", calls: 28, cacheHits: 0, products: 90, inputTokens: 25451, outputTokens: 10919, costUsd: 0.009067, costPerProductUsd: 0.000101 },
      { purpose: "build", calls: 13, cacheHits: 11, products: 2, inputTokens: 3568, outputTokens: 450, costUsd: 0.000824, costPerProductUsd: 0.000412 },
    ],
    problems: { rateLimited: 2, timeout: 0, invalidOutput: 1, error: 0 },
    overTime: Array.from({ length: 8 }, (_, i) => ({ at: `2026-10-${15 + i}T00:00:00.000Z`, calls: i === 7 ? 41 : 0, inputTokens: i === 7 ? 29019 : 0, outputTokens: i === 7 ? 11369 : 0, costUsd: i === 7 ? 0.009891 : 0 })),
  },
  savings: {
    totalUsd: 0.039552,
    cache: { usd: 0.015632, calls: 11, note: "Calls answered from saved answers cost nothing." },
    routing: { usd: 0.021152, calls: 28, note: "Cheap-model calls priced at the strong model." },
    batching: { usd: 0.002768, extraInstructionTokens: 40486, note: "Instructions sent once per batch." },
  },
  reviewReasons: {
    total: 9,
    withoutReason: 1,
    kinds: 12,
    top: [
      { key: "weight-no-unit", label: "Weight has no unit", products: 5, share: 55.6, example: { reason: 'Row 12: Weight "2,8" has no unit (kg, g or lbs?)', productId: "prod-1" } },
      { key: "ai-doubt", label: "The AI's own doubt", products: 3, share: 33.3, example: { reason: "The size may be a diameter or a height", productId: "prod-2" } },
    ],
  },
  translations: {
    products: 37,
    languages: [
      { locale: "de", enabled: true, done: 37, pending: 0, failed: 0, withProblems: 1, merchantFixes: 1, outOfDate: 1, translated: 36, coverage: 97.3 },
      { locale: "fr", enabled: false, done: 30, pending: 0, failed: 0, withProblems: 0, merchantFixes: 0, outOfDate: 0, translated: 30, coverage: 81.1 },
    ],
    outOfDate: 1,
  },
};

const quiet: Metrics = {
  ...busy,
  products: { processed: 0, catalog: { total: 0, ready: 0, needsReview: 0, approved: 0, deleted: 0 }, rates: { ready: 0, needsReview: 0, approved: 0 } },
  rows: { total: 0, done: 0, needsReview: 0, failed: 0, pending: 0, rates: { done: 0, needsReview: 0, failed: 0 } },
  imports: { total: 0, byStatus: { waiting_for_files: 0, queued: 0, running: 0, paused: 0, done: 0, failed: 0 }, speed: { averageSeconds: null, rowsPerMinute: null, slowest: null }, recent: [], topByCost: [] },
  ai: {
    ...busy.ai,
    calls: 0,
    cacheHits: 0,
    products: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costPerProductUsd: null,
    costPer1000ProductsUsd: null,
    answeredCalls: 0,
    byModel: [],
    byPurpose: [],
    problems: { rateLimited: 0, timeout: 0, invalidOutput: 0, error: 0 },
    overTime: busy.ai.overTime.map((b) => ({ ...b, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })),
  },
  reviewReasons: { total: 0, withoutReason: 0, kinds: 0, top: [] },
  savings: { ...busy.savings, totalUsd: 0, cache: { ...busy.savings.cache, usd: 0, calls: 0 }, routing: { ...busy.savings.routing, usd: 0, calls: 0 }, batching: { ...busy.savings.batching, usd: 0, extraInstructionTokens: 0 } },
  translations: {
    products: 0,
    languages: [
      { locale: "de", enabled: true, done: 0, pending: 0, failed: 0, withProblems: 0, merchantFixes: 0, outOfDate: 0, translated: 0, coverage: 0 },
      { locale: "fr", enabled: true, done: 0, pending: 0, failed: 0, withProblems: 0, merchantFixes: 0, outOfDate: 0, translated: 0, coverage: 0 },
    ],
    outOfDate: 0,
  },
};

function render(metrics: Metrics) {
  const html = [
    renderToStaticMarkup(createElement(KeyNumbers, { metrics, days: 7 })),
    renderToStaticMarkup(createElement(AiSection, { metrics, days: 7 })),
    renderToStaticMarkup(createElement(ImportsSection, { metrics, days: 7 })),
    renderToStaticMarkup(createElement(CatalogSection, { metrics })),
    renderToStaticMarkup(createElement(ReviewReasonsSection, { metrics })),
    renderToStaticMarkup(createElement(TranslationsSection, { metrics })),
  ].join("\n");
  // Text as a reader sees it: tags out, entities back
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("the Metrics tab's sections", () => {
  it("shows the period's numbers, the cost per model and per kind of work, and how savings are estimated", () => {
    const text = render(busy);
    for (const expected of [
      "Products processed 66",
      "37 in the catalog now, 12 approved",
      "Done 72 (69%)",
      "Needs review 33 (31%)",
      "AI cost $0.0099",
      "Cost per 1,000 products $0.16",
      "Money saved Estimate $0.04",
      "Cheap model where it's enough: $0.021 (28 calls)",
      "Cheap-model calls priced at the strong model.",
      "deepseek-flash $0.0083",
      "Writing products $0.00082",
      "Translating $0.0091",
      "Average 2.1 s · Slowest 5.3 s",
      "Too many requests",
      "Rows per minute 102.6",
      "Slowest import 14 s",
      "Approved 12",
      "2 deleted, not counted above",
      "German Shown to shoppers 97.3%",
      "French Switched off 81.1%",
      "1 out of date",
      "9 products waiting for review, for 12 kinds of reason. Review them",
      "Weight has no unit 5 55.6% of the products in review",
      'For example: “Row 12: Weight "2,8" has no unit (kg, g or lbs?)” See the product',
      "The AI's own doubt 3 33.3%",
      "ready to approve: 1 product",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("reads cleanly when nothing happened in the period", () => {
    const text = render(quiet);
    for (const expected of ["Products processed 0", "AI cost $0", "Cost per 1,000 products –", "No products were written in this period", "No AI calls in the last 7 days", "No imports in the last 7 days", "No products yet", "Nothing waiting for review", "No products to translate yet"]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
  });

  it("says when the products in review have nothing flagged any more", () => {
    const text = render({ ...busy, reviewReasons: { total: 2, withoutReason: 2, kinds: 0, top: [] } });
    expect(text).toContain("2 products waiting for review. Review them");
    expect(text).toContain("Nothing flagged on them any more: they only need approving");
    expect(text).not.toContain("ready to approve:");
  });
});
