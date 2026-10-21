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
    ['12"', "30.5 cm", [305]],
    ["Größe 15 cm", "15 cm", [150]],
    ["150 x 45 x 85 cm", "150 × 45 × 85 cm", [1500, 450, 850]],
    ["Ø 15 cm", "Ø 15 cm", [150]],
  ])("%s -> %s", (cell, text, mm) => {
    expect(parseSize(cell)).toEqual({ text, mm });
  });

  it("keeps volumes and labels as they are", () => {
    expect(parseSize("350 ml")).toEqual({ text: "350 ml", mm: null });
    expect(parseSize("5 L")).toEqual({ text: "5 L", mm: null });
    expect(parseSize("XL")).toEqual({ text: "XL", mm: null });
  });

  it("flags a bare number with no unit", () => {
    expect(parseSize("20")).toMatchObject({ problem: 'Size "20" has no unit (cm or inches?)' });
  });
});
