import { describe, expect, it } from "vitest";
import {
  bucketLabel,
  bucketRangeLabel,
  columnLayout,
  columnPath,
  formatCompact,
  formatLatency,
  formatPercent,
  formatUsd,
  niceScale,
  periodFromParam,
  periodPhrase,
  purposeLabel,
  share,
  translationSegments,
} from "./helpers";

describe("the period in the address", () => {
  it("reads 1, 7 or 30 days and falls back to 7 for anything else", () => {
    expect(periodFromParam("1")).toBe(1);
    expect(periodFromParam("30")).toBe(30);
    for (const value of [null, "", "9", "7days", "-1"]) expect(periodFromParam(value)).toBe(7);
    expect(periodPhrase(1)).toBe("the last 24 hours");
  });
});

describe("number formats", () => {
  it("writes small AI costs with two significant digits and larger ones in cents", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(null)).toBe("–");
    expect(formatUsd(0.000104)).toBe("$0.0001");
    expect(formatUsd(0.008638)).toBe("$0.0086");
    expect(formatUsd(0.0442)).toBe("$0.044");
    expect(formatUsd(0.159963)).toBe("$0.16");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("writes counts, shares and call times the way people read them", () => {
    expect(formatCompact(980)).toBe("980");
    expect(formatCompact(26477)).toBe("26.5K");
    expect(formatPercent(68.6)).toBe("68.6%");
    expect(formatPercent(100)).toBe("100%");
    expect(formatLatency(830)).toBe("830 ms");
    expect(formatLatency(2093)).toBe("2.1 s");
    expect(formatLatency(5000)).toBe("5 s");
    expect(formatLatency(64_000)).toBe("1 min 4 s");
    expect(formatLatency(null)).toBe("–");
  });

  it("names hourly and daily buckets in UTC, wherever the page is opened", () => {
    expect(bucketLabel("2026-10-22T14:00:00.000Z", "hour")).toBe("14:00");
    expect(bucketLabel("2026-10-22T00:00:00.000Z", "day")).toBe("Oct 22");
    expect(bucketRangeLabel("2026-10-22T23:00:00.000Z", "hour")).toBe("Oct 22, 23:00–00:00 UTC");
    expect(bucketRangeLabel("2026-10-22T00:00:00.000Z", "day")).toBe("Thu, Oct 22 (UTC)");
  });

  it("names the two kinds of AI work", () => {
    expect(purposeLabel("build")).toBe("Writing products");
    expect(purposeLabel("translate")).toBe("Translating");
  });
});

describe("chart geometry", () => {
  it("rounds an axis up to a clean top with round, evenly spaced ticks", () => {
    expect(niceScale(97)).toEqual({ max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceScale(5324)).toEqual({ max: 6000, ticks: [0, 2000, 4000, 6000] });
    expect(niceScale(0.0086)).toEqual({ max: 0.01, ticks: [0, 0.0025, 0.005, 0.0075, 0.01] });
    expect(niceScale(4)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    // Nothing to show: a plain 0..1 axis instead of dividing by zero
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });

  it("caps columns at 24 px and leaves air between them", () => {
    expect(columnLayout(8, 640)).toEqual({ slot: 80, barWidth: 24, offset: 28 });
    const dense = columnLayout(31, 310);
    expect(dense.barWidth).toBeCloseTo(7);
    expect(dense.offset).toBeCloseTo(1.5);
  });

  it("draws a column with a rounded top and a square bottom, and nothing for a zero", () => {
    expect(columnPath(10, 20, 24, 100)).toBe("M10,120V24Q10,20 14,20H30Q34,20 34,24V120Z");
    // A column 2 px tall gets a 2 px radius, not 4
    expect(columnPath(0, 98, 24, 2)).toBe("M0,100V100Q0,98 2,98H22Q24,98 24,100V100Z");
    expect(columnPath(0, 0, 24, 0)).toBe("");
  });

  it("works out shares without dividing by zero", () => {
    expect(share(1, 4)).toBe(25);
    expect(share(3, 0)).toBe(0);
  });
});

describe("translation coverage", () => {
  it("splits the catalog into translated, shown partly in English, to do, failed and not translated", () => {
    const german = { locale: "de", enabled: true, done: 30, pending: 4, failed: 1, withProblems: 2, merchantFixes: 1, outOfDate: 0, translated: 28, coverage: 75.7 };
    const parts = translationSegments(german, 37);
    expect(parts.map((p) => [p.key, p.value])).toEqual([
      ["translated", 28],
      ["problems", 2],
      ["pending", 4],
      ["failed", 1],
      ["notStarted", 2],
    ]);
    expect(parts.reduce((sum, p) => sum + p.value, 0)).toBe(37);
  });
});
