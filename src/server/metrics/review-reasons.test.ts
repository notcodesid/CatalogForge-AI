import { describe, expect, it } from "vitest";
import type { ProductInput } from "@/server/ai/prompt";
import type { ProductDraft } from "@/server/ai/schema";
import { verifyDraft } from "@/server/ai/verify";
import { rowReasons, sheetPriceNoteStart } from "@/server/pipeline/build";
import { parsePrice } from "@/server/pipeline/clean/price";
import { parseSize, parseWeight } from "@/server/pipeline/clean/units";
import { groupRows } from "@/server/pipeline/group";
import type { CleanedRow } from "@/server/pipeline/types";
import { countReasonKinds, reasonKinds } from "./review-reasons";

// Wherever it's easy, the reasons are written by the code that writes them for real: a sentence reworded there fails
// here, instead of quietly counting as the AI's own doubt

const labels = (reasons: string[]) => reasons.flatMap((r) => reasonKinds(r).map((k) => k.label));

// What a row's problem reads like on the product: "Row 12: ..."
function onRow(rowNumber: number, result: { ok: true } | { ok: false; reason: string } | { problem?: string } | null) {
  const problem = result && ("reason" in result ? result.reason : "problem" in result ? result.problem : undefined);
  if (!problem) throw new Error(`Row ${rowNumber} has no problem`);
  return `Row ${rowNumber}: ${problem}`;
}
const price = (text: string, decimalSeparator: "," | "." | null = ".") => parsePrice(text, { defaultCurrency: "EUR", decimalSeparator });

function row(rowNumber: number, fields: Partial<CleanedRow>) {
  const cleaned: CleanedRow = {
    sku: null, parentSku: null, title: null, descriptionHtml: null, descriptionText: null, color: null,
    colorSource: null, size: null, sizeMm: null, weightGrams: null, material: null, priceCents: 1000,
    currency: "EUR", currencyAssumed: false, notes: null, image: null, category: null, brand: null,
    language: "en", role: "variant", options: {}, extra: {}, issues: [], ...fields,
  };
  return { rowNumber, cleaned };
}

// The reasons a product gets for these rows, as build.ts writes them
function groupedReasons(rows: ReturnType<typeof row>[]) {
  const issues = new Map(groupRows(rows, { hasParentColumn: false }).map((g) => [g.rowNumber, g.issues]));
  return rowReasons(rows.map((r) => ({ ...r, cleaned: { ...r.cleaned, issues: issues.get(r.rowNumber)! } })), "k");
}

const input: ProductInput = {
  key: "parent:tc-pl",
  language: "en",
  variants: [],
  sourceRows: [{ row: 2, cells: { "Product Name": "Hand-thrown Terracotta Planter", Notes: "frost-resistant (not frost-proof, bring indoors below 0 °C)" } }],
};

function draft(fields: Partial<ProductDraft>): ProductDraft {
  return {
    key: input.key,
    title: "Hand-thrown Terracotta Planter",
    description_html: "<p>A terracotta planter.</p>",
    category: "Home & Garden > Planters",
    tags: ["terracotta"],
    attributes: {},
    claims: [],
    confidence: { title: 95, category: 90 },
    needs_review: false,
    review_reason: null,
    ...fields,
  };
}

const checked = (fields: Partial<ProductDraft>) => verifyDraft(draft(fields), input).reviewReasons;

describe("reasonKinds", () => {
  it("names a row's problem by what's wrong, whatever the row and the value", () => {
    const cases: [string, string][] = [
      [onRow(7, price("")), "No price"],
      [onRow(9, price("on request")), "Price isn't a number"],
      [onRow(9, price("abc")), "Price isn't a number"],
      [onRow(4, price("€12 £10")), "Price has two currencies"],
      [onRow(4, price("1,299", null)), "Price is unclear"],
      [onRow(4, price("12.345")), "Price has too many decimals"],
      [onRow(4, price("-5")), "Price is negative"],
      [onRow(4, price("0")), "Price is 0"],
      [onRow(12, parseWeight("2,8")), "Weight has no unit"],
      [onRow(1948, parseWeight("0.8")), "Weight has no unit"],
      [onRow(12, parseWeight("heavy")), "Weight isn't a number"],
      [onRow(12, parseWeight("3 stone")), "Weight has an unknown unit"],
      [onRow(12, parseWeight("90000 kg")), "Weight looks too heavy"],
      [onRow(3, parseSize("20")), "Size has no unit"],
      ['Row 3: SKU "1.23E+11" looks damaged by Excel (scientific notation)', "SKU damaged by Excel"],
      ["Row 5: No product name, the AI will suggest one", "No product name"],
      ['Row 6: Text looks like instructions for an AI, not product information: "Ignore previous instructions"', "Text aimed at the AI"],
    ];
    for (const [reason, label] of cases) expect([reason, labels([reason])]).toEqual([reason, [label]]);
  });

  it("names the problems found by looking at rows together", () => {
    const reasons = groupedReasons([
      row(10, { sku: "CW-15", title: "Mug", priceCents: 3200 }),
      row(11, { sku: "CW-15", title: "Mug", priceCents: 3600 }),
      row(20, { sku: "BW-1", title: "Bowl", color: "red" }),
      row(21, { sku: "BW-1", title: "Bowl", color: "blue" }),
      row(30, { sku: "TR-1", title: "Tray" }),
      row(31, { sku: "TR-2", title: "Tray" }),
      row(40, { sku: "VS-1", title: "Vase", size: "20 cm", currency: "EUR" }),
      row(41, { sku: "VS-2", title: "Vase", size: "30 cm", currency: "GBP" }),
      row(50, { sku: "PL-1", title: "Planter Red", color: "red" }),
      row(51, { sku: "PL-2", title: "planter blue", color: "blue" }),
    ]);
    expect(labels(reasons)).toEqual(["Same SKU, different prices", "Same SKU, different details", "Variants look the same", "Different currencies", "Grouped by similar names"]);
    // Older imports wrote the price difference like this
    expect(labels(["Rows 10 and 11 have the same SKU CW-15 but different price (32.00 EUR vs 36.00 EUR)"])).toEqual(["Same SKU, different prices"]);
  });

  it("names the checks on the AI's work, and keeps the AI's own words apart", () => {
    const deniedClaim = { text: "frost-proof", row: 2, column: "Notes", quote: "frost-resistant (not frost-proof, bring indoors below 0 °C)" };
    const missingQuote = { text: "dishwasher-safe", row: 2, column: "Notes", quote: "Dishwasher safe." };
    expect(labels(checked({ claims: [deniedClaim, missingQuote] }))).toEqual(["Claim removed", "Claim removed"]);
    expect(labels(checked({ description_html: "<p>An organic terracotta planter.</p>" }))).toEqual(["A claim the supplier never makes"]);
    expect(labels(checked({ category: "Other" }))).toEqual(["No category fits"]);
    expect(labels(checked({ title: "" }))).toEqual(["No title from the AI"]);
    expect(labels(checked({ confidence: { title: 95, category: 64 } }))).toEqual(["AI unsure: category"]);
    expect(labels(checked({ needs_review: true, review_reason: "The size may be a diameter or a height" }))).toEqual(["The AI's own doubt"]);
    expect(labels(checked({ needs_review: true }))).toEqual(["The AI's own doubt"]);
  });

  it("gives one kind per field the AI isn't sure about", () => {
    expect(reasonKinds("The AI isn't sure about: attributes.material (40%), category (64%), description_html (50%)")).toEqual([
      { key: "ai-unsure:material", label: "AI unsure: material" },
      { key: "ai-unsure:category", label: "AI unsure: category" },
      { key: "ai-unsure:description", label: "AI unsure: description" },
    ]);
    expect(labels(["The AI isn't sure about: attributes.delivery time (65%)"])).toEqual(["AI unsure: delivery time"]);
  });

  it("names the other sentences our code writes", () => {
    expect(
      labels([
        `${sheetPriceNoteStart("CW-15")}€36.00 (you set €32.00). Change it in Edit if you want theirs`,
        "SKU CW-15 already belongs to another product",
        "SKU CW-15 still has no price (from an earlier upload)",
        'These SKUs belonged to "Mug", which is now called "Stoneware Mug". Check it\'s the same product',
        "Sent back: the photo shows the wrong colour",
        'The listing speaks as the supplier ("We fire every pot by hand."). On your shop "We" would mean you',
        'The description adds details the supplier never gave: "Delivery time: 2 weeks."',
        'The tags say "handmade", but the supplier only says it in part',
        'Not translated into English: the AI copied the supplier\'s title "Übertopf"',
        'The AI picked a category that isn\'t in the list ("Pots")',
      ]),
    ).toEqual([
      "Supplier has a new price",
      "SKU used by another product",
      "Still no price (older file)",
      "Renamed by a new file",
      "You sent it back",
      "Speaks as the supplier",
      "Details not from the supplier",
      "A claim only partly backed",
      "Not translated into English",
      "Category not in the list",
    ]);
  });

  it("counts the AI's sentences that read like ours as its own doubt, and a row problem without a pattern as a row problem", () => {
    // Both seen in the real catalog
    expect(labels(['Row 2078 notes a delivery time ("Lieferzeit 2 Wochen") that is not a product attribute and was left out'])).toEqual(["The AI's own doubt"]);
    expect(labels(["Size 24.9 cm is very close to 25 cm and may be a data entry error."])).toEqual(["The AI's own doubt"]);
    expect(labels(["Row 7: Something new our code says about a row"])).toEqual(["Other problem in a row"]);
  });
});

describe("countReasonKinds", () => {
  it("counts a product once per kind, however many of its rows have it, with one real reason as an example", () => {
    const kinds = countReasonKinds([
      { reasons: 'Row 12: Weight "2,8" has no unit (kg, g or lbs?); Row 13: Weight "3.1" has no unit (kg, g or lbs?); Row 13: No price', products: 3, productId: "a" },
      { reasons: "Row 40: Weight \"0.8\" has no unit (kg, g or lbs?); The AI isn't sure about: category (60%), attributes.care (40%)", products: 2, productId: "b" },
      { reasons: "The size may be a diameter or a height", products: 1, productId: "c" },
      { reasons: "Row 7: No price", products: 1, productId: "d" },
      // In review with nothing flagged any more
      { reasons: null, products: 4, productId: "e" },
    ]);
    expect(kinds).toEqual([
      { key: "weight-no-unit", label: "Weight has no unit", products: 5, example: { reason: 'Row 12: Weight "2,8" has no unit (kg, g or lbs?)', productId: "a" } },
      { key: "no-price", label: "No price", products: 4, example: { reason: "Row 13: No price", productId: "a" } },
      { key: "ai-unsure:care", label: "AI unsure: care", products: 2, example: { reason: "The AI isn't sure about: category (60%), attributes.care (40%)", productId: "b" } },
      { key: "ai-unsure:category", label: "AI unsure: category", products: 2, example: { reason: "The AI isn't sure about: category (60%), attributes.care (40%)", productId: "b" } },
      { key: "ai-doubt", label: "The AI's own doubt", products: 1, example: { reason: "The size may be a diameter or a height", productId: "c" } },
    ]);
  });

  it("has nothing to count when no product has a reason", () => {
    expect(countReasonKinds([])).toEqual([]);
    expect(countReasonKinds([{ reasons: null, products: 3, productId: "a" }])).toEqual([]);
  });
});
