import { splitReasons } from "@/server/products/detail";

// Why products need review, sorted into kinds. A reason is a sentence about one product, with its rows, values,
// quotes and SKUs in it: 'Row 12: Weight "2,8" has no unit (kg, g or lbs?)'. Reasons that only differ by those are
// one kind ("Weight has no unit"). The sentences are written by our code (cleaning and grouping the sheet, saving the
// variants, checking the AI's work, the merchant sending a product back), so each has a pattern below. Anything that
// matches none is the AI's own words: it says why it doubts a product in a sentence of its own

export type ReasonKind = { key: string; label: string };

// Every sentence our code writes, with its kind, in the order of where they're written. A reason about one row
// starts with "Row 12: ", taken off before matching
const KINDS: (ReasonKind & { pattern: RegExp })[] = [
  // A row's price, weight, size, SKU and text (pipeline/clean/price.ts, units.ts and row.ts)
  { key: "no-price", label: "No price", pattern: /^No price$/ },
  { key: "price-not-number", label: "Price isn't a number", pattern: /^Price (is ".*", not a number|".*" isn't a number)$/ },
  { key: "price-two-currencies", label: "Price has two currencies", pattern: /^Price ".*" has more than one currency$/ },
  { key: "price-unclear", label: "Price is unclear", pattern: /^Price ".*" is unclear: / },
  { key: "price-decimals", label: "Price has too many decimals", pattern: /^Price ".*" has more than 2 decimals$/ },
  { key: "price-too-large", label: "Price is too large", pattern: /^Price ".*" is too large$/ },
  { key: "price-negative", label: "Price is negative", pattern: /^Price is negative / },
  { key: "price-zero", label: "Price is 0", pattern: /^Price is 0$/ },
  { key: "unknown-currency", label: "Unknown currency", pattern: /^Unknown currency "/ },
  { key: "currency-disagrees", label: "Price and currency disagree", pattern: /^Price says .* but the Currency column says / },
  { key: "weight-no-unit", label: "Weight has no unit", pattern: /^Weight ".*" has no unit/ },
  { key: "weight-not-number", label: "Weight isn't a number", pattern: /^Weight ".*" isn't a number/ },
  { key: "weight-unknown-unit", label: "Weight has an unknown unit", pattern: /^Weight ".*" has an unknown unit$/ },
  { key: "weight-too-heavy", label: "Weight looks too heavy", pattern: /^Weight ".*" is too heavy/ },
  { key: "size-no-unit", label: "Size has no unit", pattern: /^Size ".*" has no unit/ },
  { key: "sku-excel", label: "SKU damaged by Excel", pattern: /^SKU ".*" looks damaged by Excel/ },
  { key: "no-name", label: "No product name", pattern: /^No product name/ },
  { key: "text-for-ai", label: "Text aimed at the AI", pattern: /^Text looks like instructions for an AI/ },

  // Rows looked at together (pipeline/group.ts). Similar names go first: the names they quote could say anything, even
  // "but different"
  { key: "similar-names", label: "Grouped by similar names", pattern: /^Rows .+ were grouped as one product because the names are similar/ },
  // "different price (...)" is how older imports wrote it
  { key: "same-sku-prices", label: "Same SKU, different prices", pattern: /^Rows .+ but different prices? \(/ },
  { key: "same-sku-details", label: "Same SKU, different details", pattern: /^Rows .+ but different / },
  { key: "variants-alike", label: "Variants look the same", pattern: /^SKUs .+ are in the same product but have the same size, colour and options$/ },
  { key: "currencies", label: "Different currencies", pattern: /^Variants of this product have different currencies/ },

  // Saving the variants (pipeline/build.ts)
  { key: "sheet-price", label: "Supplier has a new price", pattern: /^SKU .+: the supplier's sheet now says / },
  { key: "sku-taken", label: "SKU used by another product", pattern: /^SKU .+ already belongs to another product$/ },
  { key: "earlier-no-price", label: "Still no price (older file)", pattern: /^SKU .+ still has no price/ },
  { key: "renamed", label: "Renamed by a new file", pattern: /^These SKUs belonged to ".*", which is now called / },

  // The checks on the AI's work (ai/verify.ts)
  { key: "no-title", label: "No title from the AI", pattern: /^The AI wrote no title$/ },
  { key: "not-translated", label: "Not translated into English", pattern: /^Not translated into English: / },
  { key: "category-unknown", label: "Category not in the list", pattern: /^The AI picked a category that isn't in the list/ },
  { key: "no-category", label: "No category fits", pattern: /^No category in the list fits this product$/ },
  // One kind whatever the claim and why it was removed (its quote isn't in the supplier's text, the supplier denies it,
  // says it only in part...): the example says which
  { key: "claim-removed", label: "Claim removed", pattern: /^Removed claim ".*": / },
  // "The title says", "The description says", "The material attribute says", "The tags say"
  { key: "claim-never", label: "A claim the supplier never makes", pattern: /^The .+ says? ".*", but the supplier never says that$/ },
  { key: "claim-partly", label: "A claim only partly backed", pattern: /^The .+ says? ".*", but the supplier only says it in part$/ },
  { key: "first-person", label: "Speaks as the supplier", pattern: /^The listing speaks as the supplier / },
  { key: "invented-details", label: "Details not from the supplier", pattern: /^The description adds details the supplier never gave/ },

  // The merchant's own note when sending an approved product back (products/review.ts)
  { key: "sent-back", label: "You sent it back", pattern: /^Sent back: / },
];

const ROW = /^Row \d+: /;

// "The AI isn't sure about: attributes.material (40%), category (64%)" is one kind per field
const UNSURE = /^The AI isn't sure about: (.+)$/;
const UNSURE_FIELD = /(?:^|, )(.+?) \(\d+%\)/g;

// The AI's own reason (or "The AI flagged this product as unclear" when it gave none)
const AI_DOUBT: ReasonKind = { key: "ai-doubt", label: "The AI's own doubt" };
// A row's problem with no pattern above: our code wrote it, so it isn't the AI's doubt
const OTHER_ROW: ReasonKind = { key: "other-row", label: "Other problem in a row" };

// "attributes.material" -> "material", "description_html" -> "description"
const fieldName = (field: string) => field.replace(/^attributes\./, "").replace(/_html$/, "");

// The kinds one reason belongs to: one, or one per field the AI isn't sure about
export function reasonKinds(reason: string): ReasonKind[] {
  const text = reason.trim();
  const unsure = text.match(UNSURE);
  if (unsure) {
    const fields = [...new Set([...unsure[1].matchAll(UNSURE_FIELD)].map((m) => fieldName(m[1].trim())))];
    return fields.length ? fields.map((field) => ({ key: `ai-unsure:${field}`, label: `AI unsure: ${field}` })) : [{ key: "ai-unsure", label: "AI unsure about a field" }];
  }
  const message = text.replace(ROW, "");
  const kind = KINDS.find((k) => k.pattern.test(message));
  if (kind) return [{ key: kind.key, label: kind.label }];
  return [ROW.test(text) ? OTHER_ROW : AI_DOUBT];
}

// Products that have the same reasons, as stored (joined with "; "), counted together, with one of them
export type ReasonGroup = { reasons: string | null; products: number; productId: string };

export type ReasonCount = ReasonKind & {
  products: number;
  // One real reason of this kind, as one product has it, so the merchant can see what the kind means
  example: { reason: string; productId: string };
};

// How many products each kind of reason holds back, most first. A product counts once per kind, even with that kind
// of reason on several rows. The example comes from the first group that has the kind (the biggest, as the query
// sorts them)
export function countReasonKinds(groups: ReasonGroup[]): ReasonCount[] {
  const counts = new Map<string, ReasonCount>();
  for (const group of groups) {
    const counted = new Set<string>();
    for (const reason of splitReasons(group.reasons)) {
      for (const kind of reasonKinds(reason)) {
        if (counted.has(kind.key)) continue;
        counted.add(kind.key);
        const count = counts.get(kind.key) ?? { ...kind, products: 0, example: { reason, productId: group.productId } };
        count.products += group.products;
        counts.set(kind.key, count);
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.products - a.products || a.label.localeCompare(b.label));
}
