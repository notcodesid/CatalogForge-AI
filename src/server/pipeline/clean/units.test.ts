import { describe, expect, it } from "vitest";
import { parseSize, parseWeight } from "./units";

describe("parseWeight", () => {
  it.each([
    ["1,8 kg", 1800],
    ["3.1kg", 3100],
    ["900 g", 900],
    ["2.2 lbs", 998],
    ["3 lbs", 1361],
    ["5 oz", 142],
  ])("%s -> %i g", (cell, grams) => {
    expect(parseWeight(cell)).toEqual({ ok: true, grams });
  });

  it("uses the unit from the header when the cell has none", () => {
    expect(parseWeight("2,5", "kg")).toEqual({ ok: true, grams: 2500 });
  });

  it("flags a bare number instead of guessing the unit", () => {
    expect(parseWeight("1.2")).toEqual({ ok: false, reason: 'Weight "1.2" has no unit (kg, g or lbs?)' });
  });

  it("returns null for an empty cell", () => {
    expect(parseWeight("  ")).toBeNull();
  });
});

describe("parseSize", () => {
  it.each([
    ["20 cm", "20 cm", [200]],
    ["8 in", "20.3 cm", [203]],
    // 30.48 cm: one decimal, not rounded to 30
    ["12 in", "30.5 cm", [305]],
    ['12"', "30.5 cm", [305]],
    ["Größe 15 cm", "15 cm", [150]],
    ["150 x 45 x 85 cm", "150 × 45 × 85 cm", [1500, 450, 850]],
    ["Ø 15 cm", "Ø 15 cm", [150]],
    // Metric keeps the supplier's unit: a 100 m spool of twine isn't "10000 cm"
    ["100 m", "100 m", [100000]],
    ["1500 mm", "1500 mm", [1500]],
    ["1,5 m", "1.5 m", [1500]],
    ["120 x 60 mm", "120 × 60 mm", [120, 60]],
    // Mixed units: each part keeps its own, inches still become cm
    ["50 cm x 1 m", "50 cm × 1 m", [500, 1000]],
    ["8 in x 20 cm", "20.3 × 20 cm", [203, 200]],
  ])("%s -> %s", (cell, text, mm) => {
    expect(parseSize(cell)).toEqual({ text, mm });
  });

  it("compares sizes written in different units by their length", () => {
    expect(parseSize("100 cm")!.mm).toEqual(parseSize("1 m")!.mm);
    expect(parseSize("50 cm")!.mm![0]).toBeLessThan(parseSize("1 m")!.mm![0]);
  });

  it("uses the unit from the header when the cell has none", () => {
    expect(parseSize("100", "m")).toEqual({ text: "100 m", mm: [100000] });
    expect(parseSize("12", "in")).toEqual({ text: "30.5 cm", mm: [305] });
  });

  it("keeps volumes and labels as they are", () => {
    expect(parseSize("350 ml")).toEqual({ text: "350 ml", mm: null });
    expect(parseSize("250 ml")).toEqual({ text: "250 ml", mm: null });
    expect(parseSize("5 L")).toEqual({ text: "5 L", mm: null });
    expect(parseSize("5 l")).toEqual({ text: "5 L", mm: null });
    expect(parseSize("1.5 l")).toEqual({ text: "1.5 L", mm: null });
    expect(parseSize("1,5 l")).toEqual({ text: "1.5 L", mm: null });
    expect(parseSize("XL")).toEqual({ text: "XL", mm: null });
  });

  it("flags a bare number with no unit", () => {
    expect(parseSize("20")).toMatchObject({ problem: 'Size "20" has no unit (cm or inches?)' });
  });
});
