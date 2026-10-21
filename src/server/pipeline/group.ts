import { isColorWord } from "./clean/color";
import { formatPrice } from "./clean/price";
import { skuKey } from "./clean/row";
import type { CleanedRow, Issue } from "./types";

export type GroupInput = { rowNumber: number; cleaned: CleanedRow };

export type GroupOptions = {
  // The sheet has a parent/group column. Then it decides what belongs together, and a row without a
  // parent is a product of its own. Grouping by similar names is only for sheets without one
  hasParentColumn: boolean;
};

export type GroupResult = {
  rowNumber: number;
  productKey: string;
  // Problems found by looking at several rows together (duplicates, conflicts)
  issues: Issue[];
  duplicateOfRow?: number;
  // The row had no currency, and the product's other variants all use this one
  currencyFromSiblings?: string;
};

const SIZE_WORDS = new Set([
  "xs", "xl", "xxl", "xxxl", "small", "medium", "large", "mini", "maxi", "klein", "mittel", "gross", "groß",
  "petit", "petite", "moyen", "moyenne", "grand", "grande",
]);
const MEASUREMENT = /\b\d+(?:[.,]\d+)?\s*(?:mm|cm|m|in|inch|inches|"|ml|cl|l|kg|g|lbs?|oz)(?=\s|$|[^a-z])/gi;

// "Hand-thrown Terracotta Planter 20cm" and "hand thrown planter - 30 cm" both become "hand thrown planter".
// Sizes, colours and size words are variant options, not part of the product's identity
export function nameKey(title: string): string {
  const words = title
    .toLowerCase()
    .replace(MEASUREMENT, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !SIZE_WORDS.has(w) && !isColorWord(w));
  return words.join(" ");
}

function productKeyFor(row: CleanedRow, options: GroupOptions): { key: string; byName: boolean } {
  if (row.parentSku) return { key: `parent:${skuKey(row.parentSku)}`, byName: false };
  if (options.hasParentColumn && row.sku) return { key: `sku:${skuKey(row.sku)}`, byName: false };
  if (row.title) {
    const name = nameKey(row.title);
    if (name) return { key: `name:${name}`, byName: true };
  }
  return { key: `sku:${skuKey(row.sku ?? "")}`, byName: false };
}

// The parts of a row that must match for two rows with the same SKU to count as an exact duplicate
const COMPARED: { field: keyof CleanedRow; label: string }[] = [
  { field: "title", label: "name" },
  { field: "descriptionText", label: "description" },
  { field: "color", label: "colour" },
  { field: "size", label: "size" },
  { field: "options", label: "options" },
  { field: "weightGrams", label: "weight" },
  { field: "priceCents", label: "price" },
  { field: "currency", label: "currency" },
  { field: "material", label: "material" },
  { field: "notes", label: "notes" },
];

function describe(row: CleanedRow, field: keyof CleanedRow): string {
  if (field === "priceCents") return row.priceCents === null ? "no price" : formatPrice(row.priceCents, row.currency ?? "");
  if (field === "weightGrams") return row.weightGrams === null ? "no weight" : `${row.weightGrams} g`;
  if (field === "options") return Object.entries(row.options).map(([k, v]) => `${k}: ${v}`).join(", ") || "none";
  const value = row[field];
  return value === null || value === undefined || value === "" ? "empty" : String(value);
}

// "5, 17 and 23", or "5, 17, 23, 40, 52 and 98 more" for long lists
function listRows(rows: number[]) {
  if (rows.length > 6) return `${rows.slice(0, 5).join(", ")} and ${rows.length - 5} more`;
  return rows.length === 2 ? `${rows[0]} and ${rows[1]}` : `${rows.slice(0, -1).join(", ")} and ${rows.at(-1)}`;
}

// What tells two variants of a product apart
function optionSignature(row: CleanedRow) {
  const other = Object.entries(row.options)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k.toLowerCase()}=${v.toLowerCase()}`);
  return [row.size ?? "", row.color ?? "", ...other].join("|");
}

// Puts rows that belong to the same product together and finds duplicates and conflicts.
// Works on the whole sheet at once, so row order doesn't matter
export function groupRows(rows: GroupInput[], options: GroupOptions): GroupResult[] {
  const results = new Map<number, GroupResult>();
  const groups = new Map<string, { rows: GroupInput[]; byName: boolean }>();

  for (const row of rows) {
    const { key, byName } = productKeyFor(row.cleaned, options);
    results.set(row.rowNumber, { rowNumber: row.rowNumber, productKey: key, issues: [] });
    const group = groups.get(key) ?? { rows: [], byName };
    group.rows.push(row);
    groups.set(key, group);
  }

  const addIssue = (rowNumber: number, issue: Issue) => results.get(rowNumber)!.issues.push(issue);

  for (const group of groups.values()) {
    // Product-info rows and photo rows belong to the product but aren't variants
    const variants = group.rows.filter((r) => r.cleaned.role === "variant");

    // Grouped only because the names look alike: a person should confirm
    if (group.byName) {
      const titles = [...new Set(variants.map((r) => r.cleaned.title ?? ""))];
      if (new Set(titles.map((t) => t.toLowerCase())).size > 1) {
        const shown = titles.slice(0, 3).map((t) => `"${t}"`).join(", ") + (titles.length > 3 ? ", ..." : "");
        const message = `Rows ${listRows(variants.map((r) => r.rowNumber))} were grouped as one product because the names are similar (${shown}), check they're the same product`;
        for (const r of variants) addIssue(r.rowNumber, { field: "title", severity: "review", message });
      }
    }

    // Same SKU on several rows: exact copies are merged, different data needs a person
    const bySku = new Map<string, GroupInput[]>();
    for (const r of variants) {
      if (!r.cleaned.sku) continue;
      const key = skuKey(r.cleaned.sku);
      bySku.set(key, [...(bySku.get(key) ?? []), r]);
    }
    for (const skuRows of bySku.values()) {
      if (skuRows.length < 2) continue;
      const first = skuRows[0];
      const differences = COMPARED.filter(({ field }) => skuRows.some((r) => describe(r.cleaned, field) !== describe(first.cleaned, field)));

      if (differences.length === 0) {
        for (const r of skuRows.slice(1)) {
          results.get(r.rowNumber)!.duplicateOfRow = first.rowNumber;
          addIssue(r.rowNumber, { field: "sku", severity: "info", message: `Same as row ${first.rowNumber}, merged` });
        }
        continue;
      }

      const detail = differences
        .map(({ field, label }) => `${label} (${skuRows.map((r) => describe(r.cleaned, field)).join(" vs ")})`)
        .join(", ");
      for (const r of skuRows) {
        addIssue(r.rowNumber, {
          field: "sku",
          severity: "review",
          message: `Rows ${listRows(skuRows.map((x) => x.rowNumber))} have the same SKU ${first.cleaned.sku} but different ${detail}`,
        });
      }
    }

    // Different SKUs in one product must differ in size, colour or another option, otherwise they aren't real variants
    const optionOwners = new Map<string, string>();
    for (const r of variants) {
      if (!r.cleaned.sku || results.get(r.rowNumber)!.duplicateOfRow) continue;
      const signature = optionSignature(r.cleaned);
      const owner = optionOwners.get(signature);
      if (owner && skuKey(owner) !== skuKey(r.cleaned.sku)) {
        addIssue(r.rowNumber, {
          field: "sku",
          severity: "review",
          message: `SKUs ${owner} and ${r.cleaned.sku} are in the same product but have the same size, colour and options`,
        });
      } else optionOwners.set(signature, r.cleaned.sku);
    }

    // Currency. A price written without one takes the currency the product's other variants use
    // (a sheet with "£45" on one size and "48" on the next means £48). Only currencies that were actually
    // written count as a conflict
    const written = new Set(variants.filter((r) => r.cleaned.priceCents !== null && !r.cleaned.currencyAssumed).map((r) => r.cleaned.currency));
    if (written.size === 1) {
      const [currency] = written as Set<string>;
      for (const r of variants) {
        if (!r.cleaned.currencyAssumed || r.cleaned.priceCents === null || r.cleaned.currency === currency) continue;
        results.get(r.rowNumber)!.currencyFromSiblings = currency;
        addIssue(r.rowNumber, {
          field: "price",
          severity: "info",
          code: "currency_assumed",
          message: `No currency given, using ${currency} like the product's other variants (${formatPrice(r.cleaned.priceCents, currency)})`,
        });
      }
    } else if (written.size > 1) {
      for (const r of variants) {
        addIssue(r.rowNumber, {
          field: "price",
          severity: "review",
          message: `Variants of this product have different currencies (${[...written].join(", ")})`,
        });
      }
    }
  }

  return rows.map((r) => results.get(r.rowNumber)!);
}
