import { findInstructions } from "@/server/ai/injection";
import { matchHeader } from "../columns";
import type { ColumnHints, CleanedRow, Field, Issue, RowRole } from "../types";
import { normalizeColor } from "./color";
import { cleanDescription, LONG_DESCRIPTION_CHARS } from "./html";
import { detectLanguage } from "./language";
import { formatPrice, parsePrice } from "./price";
import { cleanText, fixMojibake } from "./text";
import { parseSize, parseWeight, weightUnitFor, type WeightUnitGuess } from "./units";

export type RowContext = {
  defaultCurrency: string;
  hints: ColumnHints;
  // Decimal separator the price column uses, see detectDecimalSeparator
  decimalSeparator: "," | "." | null;
  // The unit most of the weight column uses, for a weight written without one (see detectWeightUnit)
  weightUnit?: WeightUnitGuess | null;
};

export type RowInput = {
  fields: Partial<Record<Field, string>>;
  // Columns we couldn't map, header -> value
  extra: Record<string, string>;
  // Option name/value pairs, e.g. { name: "Size", value: "20 cm" } (Shopify and WooCommerce exports)
  options: { name: string; value: string }[];
  role: RowRole;
};

export type CleanRowResult = {
  cleaned: CleanedRow;
  // Set when the row has nothing we can build a product from
  failReason: string | null;
};

// A SKU stays exactly as the supplier wrote it ("FS-SÜß" must not become "FS-SÜSS"), only trimmed
export function normalizeSku(raw: string | null | undefined): string | null {
  return cleanText(raw);
}

// For comparing SKUs: "tc-pl-20" and "TC-PL-20" are the same SKU
export function skuKey(sku: string): string {
  return sku.normalize("NFC").toLowerCase();
}

// Shopify writes "Title" / "Default Title" when a product has no variants
const NO_VARIANTS = /^default title$/i;

// Option columns that are really a size or a colour fill those fields, the rest are kept as named options
function readOptions(input: RowInput) {
  let size: string | undefined;
  let color: string | undefined;
  const options: Record<string, string> = {};
  input.options.forEach((option, k) => {
    const value = cleanText(option.value);
    if (!value || NO_VARIANTS.test(value)) return;
    const name = cleanText(option.name) ?? `Option ${k + 1}`;
    const field = matchHeader(name)?.field;
    if (field === "size" && !size) size = value;
    else if (field === "color" && !color) color = value;
    else options[name] = value;
  });
  return { size, color, options };
}

export function cleanRow(input: RowInput, ctx: RowContext): CleanRowResult {
  const f = input.fields;
  const issues: Issue[] = [];
  const review = (field: string, message: string) => issues.push({ field, message, severity: "review" });
  const info = (field: string, message: string) => issues.push({ field, message, severity: "info" });

  const sku = normalizeSku(f.sku);
  if (sku && /^\d+(\.\d+)?E\+\d+$/i.test(sku)) review("sku", `SKU "${sku}" looks damaged by Excel (scientific notation)`);

  // The fix itself happens in cleanText, this only tells the merchant about it
  for (const field of Object.keys(f) as Field[]) {
    const value = f[field];
    if (value && fixMojibake(value) !== value) info(field, `Fixed broken characters: "${value.trim()}" → "${cleanText(value)}"`);
  }

  // A product row's options list every value its variants have ("Small, Large"), so they aren't its own
  const options = input.role === "product" ? { size: undefined, color: undefined, options: {} } : readOptions(input);

  const title = cleanText(f.title);
  if (!title) review("title", "No product name, the AI will suggest one");

  const description = cleanDescription(f.description);
  if (description?.removedUnsafe) info("description", "Removed unsafe HTML (scripts or event handlers)");
  if (description && description.text.length > LONG_DESCRIPTION_CHARS) {
    info("description", `Description is very long (${description.text.length.toLocaleString("en")} characters)`);
  }

  const color = normalizeColor(cleanText(f.color) ?? options.color);
  if (color && !color.known) info("color", `Colour "${color.source}" isn't in the known colour list`);
  else if (color && color.source.toLowerCase() !== color.value) info("color", `Colour "${color.source}" read as "${color.value}"`);

  const size = parseSize(cleanText(f.size) ?? options.size, ctx.hints.sizeUnit);
  if (size?.problem) review("size", size.problem);

  const columnUnit = ctx.hints.weightUnit ? null : weightUnitFor(f.weight, ctx.weightUnit ?? null);
  const weight = parseWeight(f.weight, ctx.hints.weightUnit ?? columnUnit ?? undefined);
  if (weight && !weight.ok) review("weight", weight.reason);
  else if (weight && columnUnit) info("weight", `Weight "${cleanText(f.weight)}" has no unit, read as ${columnUnit} like the rest of the column`);

  const price = parsePrice(f.price, {
    currencyColumn: f.currency,
    currencyHint: ctx.hints.priceCurrency,
    defaultCurrency: ctx.defaultCurrency,
    decimalSeparator: ctx.decimalSeparator,
  });
  if (!price.ok) review("price", price.reason);
  else if (price.currencyAssumed) {
    issues.push({
      field: "price",
      severity: "info",
      code: "currency_assumed",
      message: `No currency given, using ${price.currency} (${formatPrice(price.cents, price.currency)})`,
    });
  }

  const notes = cleanText(f.notes);
  const extra: Record<string, string> = {};
  for (const [header, value] of Object.entries(input.extra)) {
    const text = cleanText(value);
    if (text) extra[header] = text;
  }

  // Text aimed at the AI rather than describing the product ("Ignore previous instructions..."):
  // a person should look, and the AI never sees it (see ai/prompt.ts)
  const instructions = [title, description?.text, notes, ...Object.values(extra)].flatMap((t) => (t ? findInstructions(t) : []));
  if (instructions.length) {
    review("description", `Text looks like instructions for an AI, not product information: "${instructions[0]}"`);
  }

  const cleaned: CleanedRow = {
    sku,
    parentSku: normalizeSku(f.parentSku),
    title,
    descriptionHtml: description?.html ?? null,
    descriptionText: description?.text ?? null,
    color: color?.value ?? null,
    colorSource: color?.source ?? null,
    size: size?.text ?? null,
    sizeMm: size?.mm ?? null,
    weightGrams: weight?.ok ? weight.grams : null,
    material: cleanText(f.material),
    priceCents: price.ok ? price.cents : null,
    currency: price.ok ? price.currency : null,
    currencyAssumed: price.ok ? price.currencyAssumed : false,
    notes,
    image: cleanText(f.image),
    category: cleanText(f.category),
    brand: cleanText(f.brand),
    language: detectLanguage([title, description?.text, notes]),
    role: input.role,
    options: options.options,
    extra,
    issues,
  };

  // Rows that aren't something you can buy don't need a price, size or weight of their own
  if (input.role === "product") {
    cleaned.issues = issues.filter((i) => !(i.severity === "review" && ["price", "size", "weight"].includes(i.field)));
    cleaned.issues.push({ field: "sku", severity: "info", message: "Product row: shared name and description for its variants" });
  }
  if (input.role === "image") {
    cleaned.issues = [{ field: "image", severity: "info", message: "Extra photo for this product" }];
    return { cleaned, failReason: null };
  }

  const failReason = !sku && !title && !description ? "Row has no SKU, product name or description" : null;
  return { cleaned, failReason };
}
