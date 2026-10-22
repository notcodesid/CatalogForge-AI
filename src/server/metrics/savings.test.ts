import { describe, expect, it } from "vitest";
import { costMicroUsd } from "@/server/ai/pricing";
import { batchingSavingMicroUsd, cachedShare, cacheSavingMicroUsd, instructionTokens, routingSavingMicroUsd } from "./savings";
import { bucketsBetween, metricsWindow, windowQuery } from "./window";

const offPeak = new Date("2026-10-24T12:00:00Z"); // a Saturday
const peak = new Date("2026-10-22T07:00:00Z"); // a Thursday, 07:00 UTC
const usage = { inputTokens: 100_000, outputTokens: 20_000, cachedInputTokens: 60_000 };

describe("cachedShare", () => {
  it("works out how much input DeepSeek served from its cache, from tokens and cost alone", () => {
    for (const hour of [offPeak, peak]) {
      const cost = costMicroUsd("deepseek-flash", usage, hour);
      expect(cachedShare({ hour, model: "deepseek-flash", inputTokens: 100_000, outputTokens: 20_000, costMicroUsd: cost })).toBeCloseTo(0.6, 3);
    }
    // The mock AI is free: nothing to work out
    expect(cachedShare({ hour: offPeak, model: "mock-cheap", inputTokens: 100, outputTokens: 10, costMicroUsd: 0 })).toBe(0);
  });
});

describe("routingSavingMicroUsd", () => {
  it("prices the cheap model's calls at the strong model, same tokens, cached share and hour", () => {
    const cost = costMicroUsd("deepseek-flash", usage, peak);
    const saved = routingSavingMicroUsd({ hour: peak, model: "deepseek-flash", calls: 3, inputTokens: 100_000, outputTokens: 20_000, costMicroUsd: cost, products: 30 }, "deepseek-v4-pro");
    expect(saved).toBeCloseTo(costMicroUsd("deepseek-v4-pro", usage, peak) - cost, -1);
    expect(saved).toBeGreaterThan(cost);
  });
});

describe("batchingSavingMicroUsd", () => {
  it("prices the instructions one call per product would have sent again", () => {
    const cost = costMicroUsd("deepseek-flash", usage, offPeak);
    const sums = { hour: offPeak, model: "deepseek-flash", calls: 2, inputTokens: 100_000, outputTokens: 20_000, costMicroUsd: cost, products: 20 };
    const extra = instructionTokens("build") * 18;
    const saved = batchingSavingMicroUsd(sums, "build");
    expect(saved.extraTokens).toBe(extra);
    expect(saved.microUsd).toBeCloseTo(costMicroUsd("deepseek-flash", { inputTokens: extra, outputTokens: 0, cachedInputTokens: Math.round(0.6 * extra) }, offPeak), -1);
    // One product per call: nothing saved
    expect(batchingSavingMicroUsd({ ...sums, products: 2 }, "build")).toEqual({ microUsd: 0, extraTokens: 0 });
  });

  it("knows the AI step's instructions are longer than a translation's", () => {
    expect(instructionTokens("build")).toBeGreaterThan(instructionTokens("translate"));
    expect(instructionTokens("translate")).toBeGreaterThan(100);
  });
});

describe("cacheSavingMicroUsd", () => {
  it("prices saved answers per product, like real calls of the same kind", () => {
    expect(cacheSavingMicroUsd(10, { costMicroUsd: 500, products: 5 })).toBe(1000);
    expect(cacheSavingMicroUsd(10, undefined)).toBe(0);
  });
});

describe("metricsWindow", () => {
  const now = new Date("2026-10-22T12:30:00Z");
  const window = (query: Record<string, string>) => metricsWindow(windowQuery.parse(query), now);

  it("covers the last 7 days by default, by the day, and short periods by the hour", () => {
    expect(window({})).toEqual({ from: new Date("2026-10-15T12:30:00Z"), to: now, bucket: "day" });
    expect(window({ days: "1" })).toMatchObject({ bucket: "hour" });
    expect(window({ from: "2026-10-01", to: "2026-10-03" })).toEqual({ from: new Date("2026-10-01"), to: new Date("2026-10-03"), bucket: "hour" });
  });

  it("refuses periods that make no sense", () => {
    expect(window({ from: "2026-10-03", to: "2026-10-01" })).toEqual({ error: "from must be before to" });
    expect(window({ from: "2024-01-01", to: "2026-01-01" })).toEqual({ error: "The period can be at most 366 days" });
    expect(windowQuery.safeParse({ days: "7", from: "2026-10-01" }).success).toBe(false);
    expect(windowQuery.safeParse({ days: "0" }).success).toBe(false);
  });

  it("lists every bucket, so quiet hours show as zero", () => {
    expect(bucketsBetween({ from: new Date("2026-10-20T00:00:00Z"), to: new Date("2026-10-22T00:00:00Z"), bucket: "hour" })).toHaveLength(48);
    expect(bucketsBetween({ from: new Date("2026-10-20T10:00:00Z"), to: new Date("2026-10-23T00:00:00Z"), bucket: "day" }).map((d) => d.toISOString())).toEqual([
      "2026-10-20T00:00:00.000Z",
      "2026-10-21T00:00:00.000Z",
      "2026-10-22T00:00:00.000Z",
    ]);
  });
});
