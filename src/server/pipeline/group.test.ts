import { describe, expect, it } from "vitest";
import { groupRows, nameKey } from "./group";
import type { CleanedRow } from "./types";

function row(rowNumber: number, fields: Partial<CleanedRow>) {
  const cleaned: CleanedRow = {
    sku: null, parentSku: null, title: null, descriptionHtml: null, descriptionText: null, color: null,
    colorSource: null, size: null, sizeMm: null, weightGrams: null, material: null, priceCents: 1000,
    currency: "EUR", currencyAssumed: false, notes: null, image: null, category: null, brand: null,
    language: "en", role: "variant", options: {}, extra: {}, issues: [], ...fields,
  };
  return { rowNumber, cleaned };
}

const noParentColumn = { hasParentColumn: false };
const withParentColumn = { hasParentColumn: true };

describe("nameKey", () => {
  it("drops sizes, colours and size words so variants share a name", () => {
    expect(nameKey("Hand-thrown Terracotta Planter 20cm")).toBe("hand thrown planter");
    expect(nameKey("hand thrown planter - 30 cm")).toBe("hand thrown planter");
    expect(nameKey("Glazed Vase Large")).toBe("glazed vase");
  });
});

describe("groupRows", () => {
  it("groups by parent SKU wherever the rows are in the sheet", () => {
    const result = groupRows(
      [
        row(14, { sku: "TC-PL-20", parentSku: "TC-PL", title: "Planter", size: "20 cm" }),
        row(3, { sku: "MG-01", title: "Mug" }),
        row(212, { sku: "TC-PL-30", parentSku: "tc-pl", title: "Planter", size: "30 cm" }),
      ],
      noParentColumn,
    );
    expect(result.map((r) => r.productKey)).toEqual(["parent:tc-pl", "name:mug", "parent:tc-pl"]);
    expect(result.flatMap((r) => r.issues)).toEqual([]);
  });

  it("trusts the parent column: rows without a parent are products of their own, even with the same name", () => {
    const result = groupRows(
      [
        row(2, { sku: "DM-001-40", title: "Doormat", size: "40 cm" }),
        row(3, { sku: "DM-777-60", title: "Doormat", size: "60 cm" }),
        row(4, { sku: "DM-900-40", parentSku: "DM-900", title: "Doormat", size: "40 cm" }),
      ],
      withParentColumn,
    );
    expect(result.map((r) => r.productKey)).toEqual(["sku:dm-001-40", "sku:dm-777-60", "parent:dm-900"]);
    expect(result.flatMap((r) => r.issues)).toEqual([]);
  });

  it("merges an exact duplicate row, and treats SKUs that differ only in case as the same", () => {
    const [first, second] = groupRows([row(2, { sku: "A-1", title: "Mug" }), row(6, { sku: "a-1", title: "Mug" })], noParentColumn);
    expect(first.duplicateOfRow).toBeUndefined();
    expect(second.duplicateOfRow).toBe(2);
    expect(second.issues).toEqual([{ field: "sku", severity: "info", message: "Same as row 2, merged" }]);
  });

  it("sends the same SKU with different data to review, showing both values", () => {
    const result = groupRows(
      [row(4, { sku: "MG-01", title: "Stoneware Mug", priceCents: 1250 }), row(5, { sku: "MG-01", title: "Stoneware Mug", priceCents: 1400 })],
      noParentColumn,
    );
    for (const r of result) {
      expect(r.issues).toContainEqual({
        field: "sku",
        severity: "review",
        message: "Rows 4 and 5 have the same SKU MG-01 but different price (12.50 EUR vs 14.00 EUR)",
      });
    }
  });

  it("asks for a check when rows were only grouped because their names look alike", () => {
    const result = groupRows(
      [row(13, { sku: "VS-1", title: "Glazed Vase", size: "25 cm" }), row(14, { sku: "VS-2", title: "Glazed Vase Large", size: "40 cm" })],
      noParentColumn,
    );
    expect(result[0].productKey).toBe(result[1].productKey);
    expect(result[0].issues[0]).toMatchObject({ severity: "review", field: "title" });
  });

  it("keeps the warning short when hundreds of rows are involved", () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(i + 2, { sku: `X-${i}`, title: i % 2 ? "Vase" : "Vase Large", size: `${i} cm` }));
    const [first] = groupRows(rows, noParentColumn);
    expect(first.issues[0].message).toContain("Rows 2, 3, 4, 5, 6 and 295 more were grouped");
  });

  it("flags two SKUs in one product with the same size, colour and options", () => {
    const result = groupRows(
      [row(1, { sku: "A-1", parentSku: "A", size: "20 cm", color: "blue" }), row(2, { sku: "A-2", parentSku: "A", size: "20 cm", color: "blue" })],
      withParentColumn,
    );
    expect(result[1].issues[0].message).toBe("SKUs A-1 and A-2 are in the same product but have the same size, colour and options");
  });

  it("doesn't flag variants that differ only in another option, like material", () => {
    const result = groupRows(
      [row(1, { sku: "A-1", parentSku: "A", options: { Material: "Oak" } }), row(2, { sku: "A-2", parentSku: "A", options: { Material: "Ash" } })],
      withParentColumn,
    );
    expect(result.flatMap((r) => r.issues)).toEqual([]);
  });

  it("gives a price without a currency the currency the product's other variants use", () => {
    const result = groupRows(
      [
        row(1, { sku: "A-1", parentSku: "A", size: "S", currency: "GBP", priceCents: 4500 }),
        row(2, { sku: "A-2", parentSku: "A", size: "M", currency: "EUR", currencyAssumed: true, priceCents: 4800 }),
      ],
      withParentColumn,
    );
    expect(result[1].currencyFromSiblings).toBe("GBP");
    expect(result[1].issues).toEqual([
      expect.objectContaining({ severity: "info", code: "currency_assumed", message: expect.stringContaining("using GBP like the product's other variants") }),
    ]);
    expect(result[0].issues).toEqual([]);
  });

  it("flags one product whose prices are written in two different currencies", () => {
    const result = groupRows(
      [
        row(1, { sku: "A-1", parentSku: "A", size: "S", currency: "EUR" }),
        row(2, { sku: "A-2", parentSku: "A", size: "M", currency: "GBP" }),
      ],
      withParentColumn,
    );
    expect(result[0].issues[0].message).toBe("Variants of this product have different currencies (EUR, GBP)");
  });

  it("leaves product-info and photo rows out of the variant checks", () => {
    const result = groupRows(
      [
        row(1, { sku: "MUG", parentSku: "MUG", role: "product", priceCents: null, currency: null }),
        row(2, { sku: "MUG-S", parentSku: "MUG", size: "S" }),
        row(3, { parentSku: "MUG", role: "image", priceCents: null, currency: null }),
      ],
      withParentColumn,
    );
    expect(new Set(result.map((r) => r.productKey))).toEqual(new Set(["parent:mug"]));
    expect(result.flatMap((r) => r.issues)).toEqual([]);
  });
});
