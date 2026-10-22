import { describe, expect, it } from "vitest";
import type { ProductInput } from "./prompt";
import type { ProductDraft } from "./schema";
import { untranslatedText, verifyDraft } from "./verify";

const input: ProductInput = {
  key: "parent:tc-pl",
  language: "en",
  variants: [],
  sourceRows: [
    { row: 2, cells: { "Product Name": "Hand-thrown Terracotta Planter", Notes: "frost-resistant (not frost-proof, bring indoors below 0 °C)" } },
    { row: 7, cells: { Description: "Handgemachter Übertopf aus Keramik. Nicht frostfest." } },
  ],
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

describe("verifyDraft", () => {
  it("passes a clean answer without review", () => {
    expect(verifyDraft(draft({}), input).reviewReasons).toEqual([]);
  });

  it("keeps a claim backed by the supplier's exact words", () => {
    const result = verifyDraft(draft({ claims: [{ text: "frost-resistant", row: 2, column: "Notes", quote: "frost-resistant (not frost-proof" }] }), input);
    expect(result.claims).toEqual([{ text: "frost-resistant", source: "row 2, column Notes", quote: "frost-resistant (not frost-proof" }]);
    expect(result.reviewReasons).toEqual([]);
  });

  it("removes a claim the supplier denies, even when the quote is real", () => {
    const result = verifyDraft(draft({ claims: [{ text: "frost-proof", row: 2, column: "Notes", quote: "frost-resistant (not frost-proof, bring indoors below 0 °C)" }] }), input);
    expect(result.claims).toEqual([]);
    expect(result.reviewReasons).toEqual(['Removed claim "frost-proof": the supplier says it isn\'t (row 2, Notes)']);
  });

  it("removes a claim whose quote isn't in the supplier's data", () => {
    const result = verifyDraft(draft({ claims: [{ text: "dishwasher-safe", row: 2, column: "Notes", quote: "Dishwasher safe." }] }), input);
    expect(result.claims).toEqual([]);
    expect(result.reviewReasons[0]).toContain("the quoted text isn't in the supplier's data");
  });

  it("accepts an English claim backed by German text", () => {
    const result = verifyDraft(draft({ claims: [{ text: "handmade", row: 7, column: "Description", quote: "Handgemachter Übertopf aus Keramik." }] }), input);
    expect(result.claims).toHaveLength(1);
    expect(result.reviewReasons).toEqual([]);
  });

  it("lists the same claim only once", () => {
    const result = verifyDraft(
      draft({
        claims: [
          { text: "handmade", row: 7, column: "Description", quote: "Handgemachter" },
          { text: "Handmade", row: 7, column: "Description", quote: "Handgemachter Übertopf" },
        ],
      }),
      input,
    );
    expect(result.claims).toHaveLength(1);
  });

  it("adds a claim the listing makes but the AI didn't list, with the supplier's sentence as the source", () => {
    const result = verifyDraft(draft({ description_html: "<p>Handmade ceramic planter.</p>", claims: [] }), input);
    expect(result.claims).toEqual([{ text: "handmade", source: "row 7, column Description", quote: "Handgemachter Übertopf aus Keramik." }]);
    expect(result.reviewReasons).toEqual([]);
  });

  it("removes a claim whose quote doesn't say it", () => {
    const result = verifyDraft(draft({ claims: [{ text: "organic", row: 2, column: "Product Name", quote: "Hand-thrown Terracotta Planter" }] }), input);
    expect(result.reviewReasons).toEqual(['Removed claim "organic": the supplier\'s text doesn\'t say that']);
  });

  it("flags a description that makes a claim the supplier never made, but not one it repeats as a denial", () => {
    const invented = verifyDraft(draft({ description_html: "<p>Dishwasher safe and frost-proof.</p>" }), input);
    expect(invented.reviewReasons).toEqual([
      'The description says "frost proof", but the supplier never says that',
      'The description says "dishwasher safe", but the supplier never says that',
    ]);
    const honest = verifyDraft(draft({ description_html: "<p>Frost-resistant, but not frost-proof.</p>" }), input);
    expect(honest.reviewReasons).toEqual([]);
  });

  it("only accepts categories from the list", () => {
    const result = verifyDraft(draft({ category: "Garden > Pots" }), input);
    expect(result.category).toBeNull();
    expect(result.reviewReasons).toEqual(['The AI picked a category that isn\'t in the list ("Garden > Pots")']);
  });

  it("fixes a category with a level missing when only one in the list fits", () => {
    const result = verifyDraft(draft({ category: "Home & Garden > Kitchen Tools" }), input);
    expect(result.category).toBe("Home & Garden > Kitchen & Dining > Kitchen Tools");
    expect(result.reviewReasons).toEqual([]);
    // The top level left out (Claude Haiku did this on a real sheet)
    expect(verifyDraft(draft({ category: "Kitchen & Dining > Mugs & Cups" }), input).category).toBe("Home & Garden > Kitchen & Dining > Mugs & Cups");
    // Same last part, but under a different top level: still review
    expect(verifyDraft(draft({ category: "Clothing > Kitchen Tools" }), input).category).toBeNull();
  });

  it("flags description sentences that add details the supplier never gave", () => {
    const labels: ProductInput = {
      key: "sku:bpl-50",
      language: "en",
      variants: [{ sku: "BPL-50", size: null, color: "natural", options: {} }],
      sourceRows: [{ row: 9, cells: { "Product Name": "Bamboo Plant Labels (50 pack)", Notes: "FSC certified bamboo." } }],
    };
    const answer = (description_html: string) => draft({ key: labels.key, title: "Bamboo Plant Labels", description_html });

    const invented = verifyDraft(answer("<p>A pack of 50 bamboo plant labels.</p><p>Ideal for marking plants in beds, pots and seed trays.</p>"), labels);
    expect(invented.reviewReasons).toEqual([
      'The description adds details the supplier never gave: "Ideal for marking plants in beds, pots and seed trays."',
    ]);

    // Rewording, counts, units and plural forms are fine
    const honest = verifyDraft(answer("<ul><li>Pack of fifty labels, made from FSC-certified bamboo</li><li>Natural colour</li></ul>"), labels);
    expect(honest.reviewReasons).toEqual([]);
  });

  it("flags the supplier's 'we' and 'our' copied into the listing, but not the US", () => {
    const vase: ProductInput = { key: "sku:vs", language: "en", variants: [], sourceRows: [{ row: 4, cells: { Description: "This glazed vase is made in our workshop. US plug." } }] };
    const answer = (description_html: string) => draft({ key: vase.key, title: "Glazed Vase", description_html });
    expect(verifyDraft(answer("<p>Glazed vase made in our workshop.</p>"), vase).reviewReasons).toEqual([
      'The listing speaks as the supplier ("Glazed vase made in our workshop."). On your shop "our" would mean you',
    ]);
    expect(verifyDraft(answer("<p>Workshop-made glazed vase with a US plug.</p>"), vase).reviewReasons).toEqual([]);
  });

  it("doesn't word-check translated products: a translation shares no words with the original", () => {
    const german: ProductInput = { key: "name:bank", language: "de", variants: [], sourceRows: [{ row: 3, cells: { Beschreibung: "Massive Eiche, geölt." } }] };
    expect(verifyDraft(draft({ key: german.key, title: "Garden Bench", description_html: "<p>Solid oiled oak bench.</p>" }), german).reviewReasons).toEqual([]);
  });

  it("sends low-confidence fields to review", () => {
    const result = verifyDraft(draft({ confidence: { title: 95, category: 64, "attributes.care": 50 } }), input);
    expect(result.reviewReasons).toEqual(["The AI isn't sure about: category (64%), attributes.care (50%)"]);
  });

  it("keeps the AI's own review reason on one line", () => {
    const result = verifyDraft(draft({ needs_review: true, review_reason: "Only the name is given; material is missing." }), input);
    expect(result.reviewReasons).toEqual(["Only the name is given, material is missing."]);
  });

  it("never lets the AI set colour or size, and cleans its HTML", () => {
    const result = verifyDraft(draft({ attributes: { Colour: "red", material: "terracotta" }, description_html: "<p onclick='x()'>Hi</p><script>bad()</script>" }), input);
    expect(result.attributes).toEqual({ material: "terracotta" });
    expect(result.descriptionHtml).toBe("<p>Hi</p>");
  });
});

describe("untranslatedText", () => {
  const german: ProductInput = {
    key: "name:gartenbank",
    language: "de",
    variants: [],
    sourceRows: [{ row: 5, cells: { Bezeichnung: "Kräuterschere", Beschreibung: "Massive Eiche, geölt. Für draußen geeignet." } }],
  };
  const answerFor = (fields: Partial<ProductDraft>) => draft({ key: german.key, ...fields });

  it("spots a German title copied as it is", () => {
    expect(untranslatedText(answerFor({ title: "Kräuterschere" }), german)).toBe('title "Kräuterschere"');
  });

  it("spots a German sentence copied into the description", () => {
    const copied = answerFor({ title: "Herb Scissors", description_html: "<p>Massive Eiche, geölt. Für draußen geeignet.</p>" });
    expect(untranslatedText(copied, german)).toBe('description "Massive Eiche, geölt."');
  });

  it("accepts a real translation, and English names a German supplier gave", () => {
    expect(untranslatedText(answerFor({ title: "Herb Scissors", description_html: "<p>Solid oiled oak, for outdoor use.</p>" }), german)).toBeNull();
    const englishName = { ...german, sourceRows: [{ row: 5, cells: { Bezeichnung: "Yoga Mat" } }] };
    expect(untranslatedText(answerFor({ title: "Yoga Mat" }), englishName)).toBeNull();
  });

  it("doesn't check products written in English", () => {
    expect(untranslatedText(draft({ title: "Hand-thrown Terracotta Planter" }), input)).toBeNull();
  });

  it("sends an untranslated listing to review", () => {
    expect(verifyDraft(answerFor({ title: "Kräuterschere" }), german).reviewReasons).toContain(
      'Not translated into English: the AI copied the supplier\'s title "Kräuterschere"',
    );
  });
});
