import { describe, expect, it } from "vitest";
import { cleanOptionNames, renameOptions, replacedOptionKeys } from "./option-names";

describe("renameOptions", () => {
  it("shows a colour column that holds scents as the scent", () => {
    expect(renameOptions({ color: "lavender", size: "200 g" }, { color: "scent" })).toEqual({ scent: "lavender", size: "200 g" });
    expect(renameOptions({ size: "6", color: "red" }, { size: "pack size" })).toEqual({ "pack size": "6", color: "red" });
  });

  it("leaves everything else as it is, and never overwrites an option the variant already has", () => {
    expect(renameOptions({ color: "lavender", Material: "soy" }, {})).toEqual({ color: "lavender", Material: "soy" });
    expect(renameOptions({ color: "lavender", Scent: "cedar" }, { color: "scent" })).toEqual({ color: "lavender", Scent: "cedar" });
  });
});

describe("cleanOptionNames", () => {
  const variants = [{ sku: "CN-1", size: null, color: "Lavender", options: { Wick: "cotton" } }];

  it("keeps a short lowercase name for colour or size, when a variant has that option", () => {
    expect(cleanOptionNames({ color: "Scent", size: "weight", material: "wax" }, variants)).toEqual({ color: "scent" });
    expect(cleanOptionNames(undefined, variants)).toEqual({});
  });

  it("refuses names that would clash or aren't a plain name", () => {
    for (const name of ["wick", "size", "color", "scent:", "x".repeat(21), ""]) expect(cleanOptionNames({ color: name }, variants)).toEqual({});
  });
});

describe("replacedOptionKeys", () => {
  it("names the earlier keys to remove before the new options are merged into the saved ones", () => {
    const options = { color: "lavender", size: "200 g" };
    expect(replacedOptionKeys(options, { color: "scent" })).toEqual(["color"]);
    // It was shown as a scent before, and isn't any more
    expect(replacedOptionKeys(options, {}, { color: "scent" })).toEqual(["scent"]);
    expect(replacedOptionKeys(options, { color: "scent" }, { color: "fragrance" })).toEqual(["color", "fragrance"]);
    // A price list without a colour column leaves the saved scent alone
    expect(replacedOptionKeys({ size: "200 g" }, { color: "scent" }, { color: "scent" })).toEqual([]);
  });
});
