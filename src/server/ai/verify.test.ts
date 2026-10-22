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
    const result = verifyDraft(draft({ attributes: { care: "Bring indoors below 0 °C" }, confidence: { title: 95, category: 64, "attributes.care": 50 } }), input);
    expect(result.reviewReasons).toEqual(["The AI isn't sure about: category (64%), attributes.care (50%)"]);
  });

  it("keeps the AI's own review reason on one line", () => {
    const result = verifyDraft(draft({ needs_review: true, review_reason: "Only the name is given; material is missing." }), input);
    expect(result.reviewReasons).toEqual(["Only the name is given, material is missing."]);
  });

  it("drops the AI's own reason when it's about prices, SKUs or variants, which our checks report", () => {
    const reason = "Both variants share SKU CW-15 with identical size and colour, so they may be duplicates or a data entry error.";
    expect(verifyDraft(draft({ needs_review: true, review_reason: reason }), input).reviewReasons).toEqual([]);
    expect(verifyDraft(draft({ needs_review: true, review_reason: "Two prices are given for the same item." }), input).reviewReasons).toEqual([]);
    // Anything else it doubts still goes to review
    expect(verifyDraft(draft({ needs_review: true, review_reason: "The material isn't clear." }), input).reviewReasons).toEqual(["The material isn't clear."]);
  });

  it("never lets the AI set colour or size, and cleans its HTML", () => {
    const result = verifyDraft(draft({ attributes: { Colour: "red", material: "terracotta" }, description_html: "<p onclick='x()'>Hi</p><script>bad()</script>" }), input);
    expect(result.attributes).toEqual({ material: "terracotta" });
    expect(result.descriptionHtml).toBe("<p>Hi</p>");
  });

  it("drops measurements when the variants have sizes, and keeps them when they don't", () => {
    const cover: ProductInput = {
      key: "parent:lcc",
      language: "en",
      variants: [
        { sku: "LCC-45", size: "45 x 45 cm", color: "sage", options: {} },
        { sku: "LCC-50", size: "50 x 50 cm", color: "sage", options: {} },
      ],
      sourceRows: [{ row: 4, cells: { "Product Name": "Linen Cushion Cover", Description: "Stonewashed linen cushion cover." } }],
    };
    const answer = draft({
      key: cover.key,
      title: "Linen Cushion Cover",
      description_html: "<p>Stonewashed linen cushion cover.</p>",
      attributes: { Dimensions: "45 x 45 cm", "Pot diameter": "20 cm", "length (cm)": "45", material: "linen" },
      // The doubt about a dropped attribute goes with it
      confidence: { title: 95, category: 90, "attributes.Dimensions": 50 },
    });
    const result = verifyDraft(answer, cover);
    expect(result.attributes).toEqual({ material: "linen" });
    expect(result.confidence).toEqual({ title: 95, category: 90 });
    expect(result.reviewReasons).toEqual([]);

    // Twine whose size is its length
    const twine: ProductInput = { ...cover, variants: [{ sku: "JT-1", size: "10000 cm", color: null, options: {} }] };
    expect(verifyDraft(draft({ attributes: { length: "10000 cm", material: "jute" } }), twine).attributes).toEqual({ material: "jute" });

    // No variant has a size: the capacity the description gives is the only place it's shown
    const jug: ProductInput = { ...cover, variants: [{ sku: "JG-1", size: null, color: "white", options: {} }] };
    expect(verifyDraft(draft({ attributes: { capacity: "2 litres" } }), jug).attributes).toEqual({ capacity: "2 litres" });

    // Seen in a real run: no attributes at all, and 0% for "attributes". Nothing to doubt, so no review
    const bare = verifyDraft(draft({ ...answer, attributes: {}, confidence: { title: 95, attributes: 0 } }), cover);
    expect(bare.confidence).toEqual({ title: 95 });
    expect(bare.reviewReasons).toEqual([]);
  });

  it("lists care instructions in attributes as claims, with the supplier's sentence as the source", () => {
    const linens: ProductInput = {
      key: "parent:np",
      language: "en",
      variants: [],
      sourceRows: [
        { row: 6, cells: { "Product Name": "Linen Napkins", Description: "Set of 4 linen napkins. Machine washable at 40 °C." } },
        { row: 8, cells: { "Product Name": "Wool Throw", Notes: "Dry clean only" } },
      ],
    };
    const answer = (attributes: Record<string, string>) =>
      draft({ key: linens.key, title: "Linen Napkins", description_html: "<p>Set of 4 linen napkins.</p>", attributes });

    const napkins = verifyDraft(answer({ material: "linen", care: "Machine washable at 40 °C" }), linens);
    expect(napkins.claims).toEqual([{ text: "machine-washable", source: "row 6, column Description", quote: "Machine washable at 40 °C." }]);
    expect(napkins.reviewReasons).toEqual([]);

    const throwCare = verifyDraft(answer({ care: "Dry clean only" }), linens);
    expect(throwCare.claims).toEqual([{ text: "dry-clean", source: "row 8, column Notes", quote: "Dry clean only" }]);

    // A care instruction the supplier never gave is flagged, wherever the listing says it
    expect(verifyDraft(answer({ care: "Tumble dry low" }), linens).reviewReasons).toEqual([
      'The care attribute says "tumble dry", but the supplier never says that',
    ]);
  });

  it("keeps a care instruction after a denial in the same sentence, and the denial a denial", () => {
    const mug: ProductInput = {
      key: "sku:mg-01",
      language: "en",
      variants: [{ sku: "MG-01", size: "350 ml", color: "grey", options: {} }],
      sourceRows: [{ row: 3, cells: { "Product Name": "Stoneware Mug", Description: "Stoneware mug, 350 ml. Not dishwasher safe, hand wash only." } }],
    };
    const answer = (fields: Partial<ProductDraft>) => draft({ key: mug.key, title: "Stoneware Mug", description_html: "<p>Stoneware mug. Not dishwasher safe.</p>", ...fields });

    const honest = verifyDraft(answer({ attributes: { care: "Hand wash only", capacity: "350 ml" } }), mug);
    expect(honest.attributes).toEqual({ care: "Hand wash only" });
    expect(honest.claims).toEqual([{ text: "hand-wash", source: "row 3, column Description", quote: "Not dishwasher safe, hand wash only." }]);
    expect(honest.reviewReasons).toEqual([]);

    const wrong = verifyDraft(
      answer({ attributes: { care: "Dishwasher safe" }, claims: [{ text: "dishwasher-safe", row: 3, column: "Description", quote: "Not dishwasher safe, hand wash only." }] }),
      mug,
    );
    expect(wrong.claims).toEqual([]);
    expect(wrong.reviewReasons).toEqual([
      'Removed claim "dishwasher-safe": the supplier says it isn\'t (row 3, Description)',
      'The care attribute says "dishwasher safe", but the supplier never says that',
    ]);
  });

  it("flags a claim made in the title or tags, and names where it is", () => {
    const bowls: ProductInput = {
      key: "sku:bw-set",
      language: "en",
      variants: [],
      sourceRows: [{ row: 21, cells: { "Product Name": "Bamboo Bowl Set", Description: "Set of 4 bamboo bowls. Hand-finished (machine made, finished by hand)." } }],
    };
    const answer = (fields: Partial<ProductDraft>) => draft({ key: bowls.key, description_html: "<p>Set of 4 bamboo bowls, hand-finished.</p>", ...fields });
    expect(verifyDraft(answer({ title: "Handmade Bamboo Bowl Set" }), bowls).reviewReasons).toEqual([
      'The title says "handmade", but the supplier never says that',
    ]);
    expect(verifyDraft(answer({ title: "Bamboo Bowl Set", tags: ["bamboo", "handmade"] }), bowls).reviewReasons).toEqual([
      'The tags say "handmade", but the supplier never says that',
    ]);
  });

  it("keeps what the AI says the colour or size column really holds, when it's usable", () => {
    const candles: ProductInput = {
      key: "parent:cn",
      language: "en",
      variants: [
        { sku: "CN-LAV", size: "200 g", color: "lavender", options: {} },
        { sku: "CN-CED", size: "200 g", color: "cedar", options: { Wick: "cotton" } },
      ],
      sourceRows: [{ row: 2, cells: { "Product Name": "Scented Soy Candle" } }],
    };
    const answer = (option_names: Record<string, string> | null) =>
      draft({ key: candles.key, title: "Scented Soy Candle", attributes: { scent: "lavender", wax: "soy" }, option_names });

    const result = verifyDraft(answer({ Colour: " Scent " }), candles);
    expect(result.optionNames).toEqual({ color: "scent" });
    // One scent for the whole product would be wrong for the cedar candle
    expect(result.attributes).toEqual({ wax: "soy" });

    expect(verifyDraft(answer(null), candles).optionNames).toEqual({});
    expect(verifyDraft(answer({ size: "fill weight", material: "wax" }), candles).optionNames).toEqual({ size: "fill weight" });
    // Not letters only, too long, a name another option has, or the other option's own name
    for (const name of ["scent!", "scent 2", "the scent of the candle", "wick", "size", "colour"]) {
      expect(verifyDraft(answer({ color: name }), candles).optionNames).toEqual({});
    }
    // No variant has a colour, so there's nothing to rename
    const plain = { ...candles, variants: candles.variants.map((v) => ({ ...v, color: null })) };
    expect(verifyDraft(answer({ color: "scent" }), plain).optionNames).toEqual({});
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
