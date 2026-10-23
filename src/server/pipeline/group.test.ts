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

  it("puts a row without a parent into the family its SKU starts with, when the name is the same", () => {
    // Seen on a 10,000-row sheet: the 4 sizes of FXBB-03493 became three "Bamboo Bowl" products
    const result = groupRows(
      [
        row(15, { sku: "FXBB-03493-15", title: "Bamboo Bowl", size: "15 cm" }),
        row(102, { sku: "FXBB-03493-40", parentSku: "FXBB-03493", title: "Bamboo Bowl", size: "40 cm" }),
        row(7248, { sku: "FXBB-03493-10", parentSku: "FXBB-03493", title: "Bamboo Bowl", size: "10 cm" }),
        row(7987, { sku: "FXBB-03493-30", title: "Bamboo Bowl", size: "30 cm" }),
        // Starts with a parent but is another product: stays on its own
        row(20, { sku: "BW-SET", title: "Bamboo Bowl Set" }),
        row(21, { sku: "BW-1", parentSku: "BW", title: "Wooden Bowl" }),
      ],
      withParentColumn,
    );
    expect(result.map((r) => r.productKey)).toEqual(["parent:fxbb-03493", "parent:fxbb-03493", "parent:fxbb-03493", "parent:fxbb-03493", "sku:bw-set", "parent:bw"]);
    // The merchant can see why
    expect(result[0].issues).toEqual([{ field: "sku", severity: "info", message: "No Parent SKU: joined FXBB-03493, because the SKU starts with it and the name is the same" }]);
    expect(result[4].issues).toEqual([]);
  });

  it("groups rows that all lack a parent when their SKUs share a start and the names match", () => {
    // Seen on a 2,000-row sheet: both sizes of FYCN-00253 had no Parent SKU and became two "Soy Candle" products
    const result = groupRows(
      [
        row(2, { sku: "FYCN-00253-10", title: "Soy Candle", size: "10 cm" }),
        row(3, { sku: "FYCN-00253-25", title: "Soy Candle", size: "25 cm" }),
        // Same start, another name: a product of its own (even "Large", which nameKey would drop). A lone row too
        row(4, { sku: "FYCN-00253-XL", title: "Soy Candle Large" }),
        row(5, { sku: "DM-001-40", title: "Doormat" }),
        row(6, { sku: "PS-1-40", parentSku: "PS-1", title: "Plant Stand" }),
      ],
      withParentColumn,
    );
    expect(result.map((r) => r.productKey)).toEqual(["parent:fycn-00253", "parent:fycn-00253", "sku:fycn-00253-xl", "sku:dm-001-40", "parent:ps-1"]);
    expect(result[0].issues).toEqual([
      { field: "sku", severity: "info", message: "No Parent SKU: grouped with the other rows whose SKU starts with FYCN-00253- and that have the same name" },
    ]);
  });

  it("merges an exact duplicate row, and treats SKUs that differ only in case as the same", () => {
    const [first, second] = groupRows([row(2, { sku: "A-1", title: "Mug" }), row(6, { sku: "a-1", title: "Mug" })], noParentColumn);
    expect(first.duplicateOfRow).toBeUndefined();
    expect(second.duplicateOfRow).toBe(2);
    expect(second.issues).toEqual([{ field: "sku", severity: "info", message: "Same as row 2, merged" }]);
  });

  it("sends the same SKU with different prices to review, showing both and saying how to fix it", () => {
    const result = groupRows(
      [row(4, { sku: "MG-01", title: "Stoneware Mug", priceCents: 1250 }), row(5, { sku: "MG-01", title: "Stoneware Mug", priceCents: 1400 })],
      noParentColumn,
    );
    for (const r of result) {
      expect(r.duplicateOfRow).toBeUndefined();
      expect(r.issues).toEqual([
        {
          field: "price",
          severity: "review",
          message: "Rows 4 and 5 have the same SKU MG-01 but different prices (€12.50 vs €14.00). Enter the right one with Edit",
        },
      ]);
    }
  });

  it("keeps the price apart from the other differences, and doesn't repeat the currency the prices already show", () => {
    const [first] = groupRows(
      [
        row(10, { sku: "CW-15", title: "Watering Can", priceCents: 3200, weightGrams: 500 }),
        row(11, { sku: "CW-15", title: "Watering Can", priceCents: 3200, currency: "GBP", weightGrams: 600 }),
      ],
      noParentColumn,
    );
    expect(first.issues.filter((i) => i.message.includes("same SKU")).map((i) => [i.field, i.message])).toEqual([
      ["price", "Rows 10 and 11 have the same SKU CW-15 but different prices (€32.00 vs £32.00). Enter the right one with Edit"],
      ["sku", "Rows 10 and 11 have the same SKU CW-15 but different weight (500 g vs 600 g)"],
    ]);

    const [samePrice] = groupRows([row(10, { sku: "CW-15", color: "red" }), row(11, { sku: "CW-15", color: "blue" })], noParentColumn);
    expect(samePrice.issues.map((i) => i.message)).toEqual(["Rows 10 and 11 have the same SKU CW-15 but different colour (red vs blue)"]);
  });

  it("treats rows without a SKU but with the same options as one variant: copies merged, different prices flagged", () => {
    const copies = groupRows([row(2, { title: "Garden Bench" }), row(3, { title: "Garden Bench" }), row(4, { title: "Garden Bench", size: "L" })], noParentColumn);
    expect(copies.map((r) => r.duplicateOfRow)).toEqual([undefined, 2, undefined]);
    expect(copies[2].issues).toEqual([]);

    const [first] = groupRows([row(2, { title: "Garden Bench", priceCents: 12000 }), row(3, { title: "Garden Bench", priceCents: 13000 })], noParentColumn);
    expect(first.issues).toEqual([
      {
        field: "price",
        severity: "review",
        message: "Rows 2 and 3 have no SKU and the same size, colour and options but different prices (€120.00 vs €130.00). Enter the right one with Edit",
      },
    ]);
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

  it("compares lengths by their millimetres, since sizes keep the supplier's unit", () => {
    // "100 cm" and "1 m" are the same size: two SKUs with them are flagged, the same SKU with them is an exact copy
    const sameSize = groupRows(
      [row(1, { sku: "R-1", parentSku: "R", size: "100 cm", sizeMm: [1000] }), row(2, { sku: "R-2", parentSku: "R", size: "1 m", sizeMm: [1000] })],
      withParentColumn,
    );
    expect(sameSize[1].issues[0].message).toBe("SKUs R-1 and R-2 are in the same product but have the same size, colour and options");
    const copies = groupRows([row(1, { sku: "R-1", size: "100 cm", sizeMm: [1000] }), row(2, { sku: "R-1", size: "1 m", sizeMm: [1000] })], noParentColumn);
    expect(copies[1].duplicateOfRow).toBe(1);
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
