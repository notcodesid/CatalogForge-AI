import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanRow } from "./clean/row";
import { prepareRows } from "./prepare-rows";
import { readSheet } from "./read-sheet";

function prepare(file: string) {
  const sheet = readSheet(readFileSync(file), file.endsWith(".xlsx") ? "xlsx" : "csv");
  const inputs = prepareRows(sheet.rows.map((r) => r.values), sheet.info);
  const cleaned = inputs.map((input) => cleanRow(input, { defaultCurrency: "EUR", hints: sheet.info.hints, decimalSeparator: null }).cleaned);
  return { sheet, inputs, cleaned };
}

describe("Shopify export", () => {
  const { sheet, cleaned } = prepare("samples/test-files/01-real-format/shopify_products_export.csv");

  it("is recognised, with prices, weights, descriptions and options read from Shopify's columns", () => {
    expect(sheet.info.format).toBe("shopify");
    expect(sheet.info.columns).toMatchObject({
      sku: "Variant SKU",
      parentSku: "Handle",
      title: "Title",
      description: "Body (HTML)",
      price: "Variant Price",
      weight: "Variant Grams",
      brand: "Vendor",
      category: "Product Category",
      image: "Image Src",
    });
    expect(cleaned[0]).toMatchObject({ sku: "TC-PL-20", priceCents: 2499, weightGrams: 1800, size: "20 cm", brand: "Green Fingers Ltd" });
  });

  it("gives variant rows the product's name and description from its first row", () => {
    expect(cleaned[1]).toMatchObject({ sku: "TC-PL-30", title: "Terracotta Planter", size: "30 cm", priceCents: 3499 });
    expect(cleaned[1].descriptionText).toContain("Classic terracotta planter");
  });

  it("reads colour and size from option columns, even where Shopify leaves the option name out", () => {
    expect(cleaned[3]).toMatchObject({ sku: "LCC-SAGE-45", color: "sage", size: "45x45" });
    expect(cleaned[5]).toMatchObject({ sku: "LCC-OAT-45", color: "oat", title: "Linen Cushion Cover" });
  });

  it("treats a row with only a photo as an extra photo, not a broken product", () => {
    expect(cleaned[6]).toMatchObject({ role: "image", sku: null, image: expect.stringContaining("lcc-detail.jpg") });
  });

  it("ignores Shopify's 'Default Title' option for products without variants", () => {
    expect(cleaned[7]).toMatchObject({ sku: "WC-EN-2", options: {}, size: null });
  });
});

describe("WooCommerce export", () => {
  const { sheet, cleaned } = prepare("samples/test-files/01-real-format/woocommerce_products_export.csv");

  it("uses Regular price, not Sale price, and Categories, not Type", () => {
    expect(sheet.info.format).toBe("woocommerce");
    expect(sheet.info.columns).toMatchObject({ price: "Regular price", category: "Categories", sku: "SKU", title: "Name" });
    expect(sheet.info.unmappedColumns).toEqual(expect.arrayContaining(["Sale price", "Type", "Short description"]));
  });

  it("links variations to their parent product through Parent = id:101", () => {
    expect(cleaned.slice(0, 4).map((c) => c.parentSku)).toEqual(["MUG-STN", "MUG-STN", "MUG-STN", "MUG-STN"]);
    expect(cleaned[0].role).toBe("product");
    expect(cleaned[0].issues.filter((i) => i.severity === "review")).toEqual([]);
  });

  it("reads each variation's colour and size and gives it the product's description and category", () => {
    expect(cleaned[2]).toMatchObject({ sku: "MUG-STN-WH-L", priceCents: 2200, color: "speckled white", size: "Large", category: "Kitchen > Mugs" });
    expect(cleaned[2].descriptionText).toContain("thrown by hand");
  });
});

describe("unknown column names", () => {
  const { sheet, cleaned } = prepare("samples/test-files/06-unknown-columns/unknown_columns.csv");

  it("finds name, retail price, colour and dimensions, but never the trade price or the pack size", () => {
    expect(sheet.info.columns).toMatchObject({
      sku: "Item Code",
      title: "Item Desc",
      price: "RRP incl. VAT",
      color: "Colourway",
      size: "Dims (LxWxH)",
      notes: "Comments",
    });
    expect(sheet.info.unmappedColumns).toEqual(expect.arrayContaining(["Trade Price", "Pack size", "EAN", "HS Code"]));
    expect(cleaned[0]).toMatchObject({ title: "Terracotta Pot Set (3 pcs)", priceCents: 2999, currency: "GBP", color: "natural", size: "20 × 20 × 18 cm" });
    expect(cleaned[2]).toMatchObject({ color: "natural/grey" });
  });
});
