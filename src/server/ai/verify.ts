import type { Claim } from "@/server/db/schema";
import { cleanDescription } from "@/server/pipeline/clean/html";
import { cleanText } from "@/server/pipeline/clean/text";
import { claimedConcepts, claimLabel, findMentions, normalizeForMatch } from "./claims";
import { CONFIDENCE_THRESHOLD } from "./confidence";
import { cleanOptionNames, type OptionNames } from "./option-names";
import type { ProductInput } from "./prompt";
import type { ProductDraft } from "./schema";
import { isCategory, nearestCategory } from "./taxonomy";

export type VerifiedDraft = {
  title: string;
  descriptionHtml: string;
  category: string | null;
  tags: string[];
  attributes: Record<string, string>;
  // What the variants' colour or size really is, when it isn't one: { color: "scent" } (see option-names.ts)
  optionNames: OptionNames;
  claims: Claim[];
  confidence: Record<string, number>;
  // Why this product needs a person to look at it. Empty = the AI's work passed every check
  reviewReasons: string[];
};

// What the AI is told not to flag, because pipeline/group.ts and build.ts check it with the exact rows and values.
// Seen in a real run: "Both variants share SKU CW-15..." on a product with one variant, next to our own clearer
// "Rows 10 and 11 have the same SKU CW-15 but different prices (€32.00 vs €36.00)"
const CHECKED_BY_CODE = /\b(?:skus?|prices?|priced|pricing|variants?|duplicates?|duplicated)\b/i;

// "We", "our", "us" (not "US", the country)
const FIRST_PERSON = /\b(?:[Ww]e|[Oo]urs?|us)\b/;

// Colour and size come from our own cleaning, per variant. The AI doesn't get to set them
const FACT_ATTRIBUTES = new Set(["color", "colour", "size", "price", "sku", "weight"]);

// Measurements ("length", "pot diameter", "dimensions (cm)"). When the variants have sizes, each variant has its
// own: one value for the whole product repeats it ("length: 10000 cm" on twine whose size says the same) or is
// wrong for all variants but one ("45 x 45 cm" on a cover that also comes in 50 x 50)
const MEASUREMENT = /\b(?:sizes?|length|width|height|depth|dimensions?|measurements?|diameter|radius|circumference|capacity|volume)\b/;
const isMeasurement = (name: string) => MEASUREMENT.test(normalizeForMatch(name));

type Cell = { row: number; column: string; text: string; normalized: string };

function cellsOf(input: ProductInput): Cell[] {
  return input.sourceRows.flatMap((r) =>
    Object.entries(r.cells).map(([column, text]) => ({ row: r.row, column, text, normalized: normalizeForMatch(text) })),
  );
}

// The shop is in English. When the supplier wrote in German or French, an AI that copies their title or
// sentences word for word hasn't translated. Returns what was copied, or null
export function untranslatedText(draft: ProductDraft, input: ProductInput): string | null {
  if (input.language !== "de" && input.language !== "fr") return null;
  const cells = cellsOf(input);
  const copied = (text: string, minWords: number) => {
    const normalized = normalizeForMatch(text);
    return normalized.split(" ").length >= minWords && cells.some((c) => c.normalized.includes(normalized));
  };
  // A copied title only counts when it isn't plain English letters (ä, ß, é...): German suppliers often give
  // products English names, and copying those is fine
  const title = cleanText(draft.title) ?? "";
  if (title && /[^ -~]/.test(title) && copied(title, 1)) return `title "${title}"`;
  const sentences = (cleanDescription(draft.description_html)?.text ?? "").split(/(?<=[.!?])\s+/);
  const sentence = sentences.find((s) => copied(s, 3));
  return sentence ? `description "${sentence}"` : null;
}

// Words that add no fact of their own: grammar, counts, units and the plain words any listing needs
const PLAIN_WORDS = new Set(
  [
    "the and but for from with without into onto over under about this that these those its are was were been being has have",
    "had can will may each every any all both either other some such you your our their they them which who when where",
    "while than then there here also very more most only not per via too own same please note",
    "made make makes come comes include includes included including feature features featuring available offered sold",
    "supplied set sets pack packs piece pieces pcs item items product products size sizes capacity colour colours color colors",
    "option options variant variants choice choose one two three four five six seven eight nine ten eleven twelve twenty",
    "thirty forty fifty hundred dozen pair",
    "single metre metres meter meters centimetre centimetres millimetre millimetres litre litres liter liters millilitre",
    "millilitres gram grams kilogram kilograms inch inches",
  ]
    .join(" ")
    .split(" "),
);

// "galvanized" and "galvanised", "colour" and "color", "plants" and "planting" count as the same word
function stem(word: string): string {
  return word.replace(/iz/g, "is").replace(/our/g, "or").replace(/(ies|es|s|ing|ed|er|ly)$/, "");
}

// The words in a piece of text that could carry a fact: no numbers, no short or plain words
export function factWords(text: string): string[] {
  return normalizeForMatch(text)
    .split(" ")
    .filter((w) => w.length >= 3 && !/\d/.test(w) && !PLAIN_WORDS.has(w))
    .map(stem);
}

function sentencesOf(html: string): string[] {
  return html
    .split(/<\/(?:p|li)>|<br\s*\/?>/)
    .map((part) => cleanDescription(part)?.text ?? "")
    .flatMap((text) => text.split(/(?<=[.!?])\s+/))
    .filter(Boolean);
}

// An invented detail the claim check can't see ("for marking plants in beds, pots and seed trays") still uses
// words the supplier never wrote. A sentence with 2 or more of them goes to review. Only for English suppliers:
// a translation shares no words with the German or French it came from
function unsupportedSentences(descriptionHtml: string, input: ProductInput): string[] {
  if (input.language !== "en") return [];
  const isKnown = wordChecker([
    ...cellsOf(input).map((c) => c.text),
    ...input.variants.flatMap((v) => [v.size, v.color, ...Object.values(v.options)]),
  ]);
  return sentencesOf(descriptionHtml).filter((sentence) => new Set(factWords(sentence).filter((w) => !isKnown(w))).size >= 2);
}

// Tells whether a word (from factWords) appears in the given texts. Short forms count too: the supplier's
// "galv." covers "galvanised", their "planter" covers "plant"
export function wordChecker(texts: (string | null | undefined)[]): (word: string) => boolean {
  const known = new Set(factWords(texts.filter(Boolean).join(" ")));
  return (word) =>
    known.has(word) || [...known].some((k) => (k.length >= 4 && word.startsWith(k)) || (word.length >= 4 && k.startsWith(word)));
}

// Checks everything the AI wrote against the supplier's own text. We don't trust the model to police
// itself: an unsupported claim is removed, and anything doubtful sends the product to review
export function verifyDraft(draft: ProductDraft, input: ProductInput): VerifiedDraft {
  const reasons: string[] = [];
  const cells = cellsOf(input);
  const sourceClaims = claimedConcepts(cells.map((c) => c.text).join(". "));

  const title = cleanText(draft.title) ?? "";
  if (!title) reasons.push("The AI wrote no title");

  const description = cleanDescription(draft.description_html);
  const descriptionHtml = description?.html ?? "";

  const untranslated = untranslatedText(draft, input);
  if (untranslated) reasons.push(`Not translated into English: the AI copied the supplier's ${untranslated}`);

  let category: string | null = draft.category.trim();
  if (!isCategory(category)) category = nearestCategory(category) ?? category;
  if (!isCategory(category)) {
    reasons.push(`The AI picked a category that isn't in the list ("${category}")`);
    category = null;
  } else if (category === "Other") {
    reasons.push("No category in the list fits this product");
  }

  const tags = [...new Set(draft.tags.map((t) => cleanText(t)?.toLowerCase()).filter((t): t is string => Boolean(t)))]
    .filter((t) => t.length <= 40)
    .slice(0, 10);

  // A colour column that holds scents makes "scent" a per-variant fact too
  const optionNames = cleanOptionNames(draft.option_names, input.variants);
  const variantFacts = new Set([...FACT_ATTRIBUTES, ...Object.values(optionNames)]);
  // A size column that really holds something else (pack counts, scents) isn't a measurement
  const sizeIsMeasurement = !optionNames.size || isMeasurement(optionNames.size);
  const hasSizes = input.variants.some((v) => (v.size && sizeIsMeasurement) || Object.keys(v.options).some(isMeasurement));
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(draft.attributes)) {
    const key = cleanText(name)?.toLowerCase();
    const text = cleanText(value);
    if (key && text && !variantFacts.has(key) && !(hasSizes && isMeasurement(key))) attributes[key] = text;
  }

  // Claims: the quote must really be in the supplier's text, and a risky claim must be what that text says,
  // not what it denies
  const claims: Claim[] = [];
  for (const claim of draft.claims) {
    const quote = normalizeForMatch(claim.quote);
    const found =
      cells.find((c) => c.row === claim.row && c.column === claim.column && c.normalized.includes(quote)) ??
      cells.find((c) => quote && c.normalized.includes(quote));
    if (!quote || !found) {
      reasons.push(`Removed claim "${claim.text}": the quoted text isn't in the supplier's data`);
      continue;
    }

    const concepts = claimedConcepts(claim.text);
    const cellMentions = findMentions(found.text);
    const unsupported = [...concepts].find((id) => !cellMentions.some((m) => m.concept.id === id && !m.negated));
    if (unsupported) {
      const denied = cellMentions.some((m) => m.concept.id === unsupported && m.negated);
      reasons.push(
        denied
          ? `Removed claim "${claim.text}": the supplier says it isn't (row ${found.row}, ${found.column})`
          : `Removed claim "${claim.text}": the supplier's text doesn't say that`,
      );
      continue;
    }
    // The same claim found in two columns is listed once
    if (claims.some((c) => normalizeForMatch(c.text) === normalizeForMatch(claim.text))) continue;
    claims.push({ text: claim.text, source: `row ${found.row}, column ${found.column}`, quote: claim.quote });
  }

  // Everything the shop shows that can make a claim. Attribute values too: "care: dry clean only" is a promise
  const fields = [
    { says: "The title says", text: title },
    { says: "The description says", text: description?.text ?? "" },
    ...Object.entries(attributes).map(([key, value]) => ({ says: `The ${key.replace(/;/g, ",")} attribute says`, text: value })),
    { says: "The tags say", text: tags.join(". ") },
  ];

  // The listing itself must not make risky claims the supplier never made, even outside the claims list
  const reported = new Set<string>();
  for (const field of fields) {
    for (const m of findMentions(field.text)) {
      if (m.negated || sourceClaims.has(m.concept.id) || reported.has(m.concept.id)) continue;
      reported.add(m.concept.id);
      reasons.push(`${field.says} "${m.phrase}", but the supplier never says that`);
    }
  }

  // The listing says "handmade", the supplier says so too, but the AI left it out of the claims: add it with its
  // source, so every claim the shop makes points back to the supplier's words
  for (const id of claimedConcepts(fields.map((f) => f.text).join(". "))) {
    if (!sourceClaims.has(id) || claims.some((c) => claimedConcepts(c.text).has(id))) continue;
    for (const cell of cells) {
      const sentence = cell.text.split(/(?<=[.!?])\s+/).find((s) => claimedConcepts(s).has(id));
      if (!sentence) continue;
      claims.push({ text: claimLabel(id), source: `row ${cell.row}, column ${cell.column}`, quote: sentence });
      break;
    }
  }

  // The supplier's "we" and "our" copied into the listing: on the merchant's shop it would mean the merchant
  const firstPerson = [title, ...sentencesOf(descriptionHtml), ...claims.map((c) => c.text)].find((s) => FIRST_PERSON.test(s));
  if (firstPerson) {
    const word = firstPerson.match(FIRST_PERSON)![0];
    reasons.push(`The listing speaks as the supplier ("${firstPerson.replace(/;/g, ",")}"). On your shop "${word}" would mean you`);
  }

  // Other details the supplier never gave. A sentence already reported above for a risky claim isn't repeated
  const invented = unsupportedSentences(descriptionHtml, input).filter(
    (s) => !findMentions(s).some((m) => !m.negated && !sourceClaims.has(m.concept.id)),
  );
  if (invented.length) {
    const quoted = invented.slice(0, 2).map((s) => `"${s.length > 150 ? `${s.slice(0, 150)}…` : s}"`.replace(/;/g, ","));
    reasons.push(`The description adds details the supplier never gave: ${quoted.join(" and ")}`);
  }

  // Confidence only for what the listing shows. The merchant can't fix a doubt about an attribute that was dropped,
  // and a score for "attributes" when there are none means "nothing to say" (seen in a real run: 0%), not a doubt
  const shown = (field: string) => {
    if (field === "attributes") return Object.keys(attributes).length > 0;
    if (!field.startsWith("attributes.")) return true;
    const attribute = cleanText(field.slice("attributes.".length))?.toLowerCase();
    return attribute !== undefined && attribute in attributes;
  };
  const confidence: Record<string, number> = {};
  for (const [field, value] of Object.entries(draft.confidence)) {
    if (shown(field)) confidence[field] = Math.round(Math.min(100, Math.max(0, value)));
  }
  const low = Object.entries(confidence).filter(([, value]) => value < CONFIDENCE_THRESHOLD);
  if (low.length) reasons.push(`The AI isn't sure about: ${low.map(([field, value]) => `${field} (${value}%)`).join(", ")}`);

  // Semicolons separate our list of reasons, so the AI's own reason mustn't contain any. A reason about prices, SKUs
  // or variants is dropped: our own checks give those with the exact rows and values
  if (draft.needs_review) {
    const reason = draft.review_reason?.trim().replace(/\s*;\s*/g, ", ") || "The AI flagged this product as unclear";
    if (!CHECKED_BY_CODE.test(reason)) reasons.push(reason);
  }

  return { title, descriptionHtml, category, tags, attributes, optionNames, claims, confidence, reviewReasons: reasons };
}
