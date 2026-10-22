import { matchHeader } from "@/server/pipeline/columns";
import type { TranslatedFields } from "@/server/translations/fields";
import type { TranslatedProduct, TranslateInput } from "@/server/translations/prompt";
import { findMentions, normalizeForMatch } from "./claims";
import type { BuildInput, ProductInput } from "./prompt";
import { AiOutOfCreditError, AiRateLimitError, AiTemporaryError, type AiProvider, type AiRequest, type AiResult, type AiTier } from "./provider";
import type { ProductDraft } from "./schema";
import type { Category } from "./taxonomy";

// A fake AI: answers instantly, offline and for free, with simple rules instead of a model. Used for tests,
// for large speed tests without spending AI quota, and as the app's demo mode.
// MOCK_AI_MODE makes it misbehave on purpose, to prove our checks catch it (comma separated):
//   invent      add claims the supplier never made, and turn "not frost-proof" into "frost-proof"
//   fail:N      the first N calls fail like an overloaded provider
//   ratelimit   the first call is refused with "too many requests"
//   nocredit:N  the first N calls are refused because the account is out of credit
//   truncate    the first call is cut off mid-answer
//   badjson     the first call returns broken JSON
//   notranslate copy German/French text instead of "translating" it, and leave translations in English
// The mock can't really translate: for German/French products it marks its text as translated instead, and its
// translations into German and French put "[DE]" or "[FR]" in front of every sentence (numbers, units and HTML
// tags untouched, so they pass the checks). With "invent", a translation also claims frost-proof and dishwasher-safe

const CATEGORY_KEYWORDS: [RegExp, Category][] = [
  [/watering can|gießkanne|arrosoir/i, "Home & Garden > Watering"],
  [/bench|gartenbank|banc de jardin/i, "Home & Garden > Garden Furniture"],
  [/seed|anzucht/i, "Home & Garden > Seeds & Propagation"],
  [/plant label|fertili|dünger/i, "Home & Garden > Plant Care"],
  [/doormat|fußmatte|paillasson/i, "Home & Garden > Doormats"],
  [/vase/i, "Home & Garden > Decor > Vases"],
  [/candle|kerze|bougie/i, "Home & Garden > Decor > Candles & Home Fragrance"],
  [/\bcushions?\b|kissen|coussin|\bplaids?\b|\bthrows?\b/i, "Home & Garden > Decor > Cushions & Throws"],
  [/lamp|lampe|leuchte/i, "Home & Garden > Lighting > Lamps"],
  [/\bmugs?\b|\bcups?\b|tasse|becher/i, "Home & Garden > Kitchen & Dining > Mugs & Cups"],
  [/bowl|plate|schale|teller|assiette/i, "Home & Garden > Kitchen & Dining > Plates & Bowls"],
  [/scissors|schere|ciseaux/i, "Home & Garden > Kitchen & Dining > Kitchen Tools"],
  [/bucket|eimer|seau|trowel|spade|rake/i, "Home & Garden > Garden Tools"],
  [/tote|\bbags?\b|tasche/i, "Bags & Accessories > Bags"],
  [/yoga|fitness/i, "Sports & Outdoors > Fitness & Yoga"],
  [/gift card|gutschein|carte cadeau/i, "Gifts > Gift Cards"],
  // Last: "pot" also appears in "candle in a ceramic pot"
  [/planter|\bpots?\b|übertopf|cache-pot|blumenkasten|plant hanger|hanging basket/i, "Home & Garden > Planters"],
];

const MATERIALS: [RegExp, string][] = [
  [/terracotta|terrakotta/i, "terracotta"],
  [/stoneware|steinzeug/i, "stoneware"],
  [/porcelain|porzellan/i, "porcelain"],
  [/ceramic|keramik|céramique/i, "ceramic"],
  [/linen|leinen/i, "linen"],
  [/cotton|baumwolle|coton/i, "cotton"],
  [/bamboo|bambus|bambou/i, "bamboo"],
  [/\boak\b|eiche|chêne/i, "oak"],
  [/enamel|emaille/i, "enamel"],
  [/galvani[sz]ed|verzinkt|galvanisé/i, "galvanised steel"],
  [/jute/i, "jute"],
  [/soy wax|cire de soja|sojawachs/i, "soy wax"],
  [/coir|kokos/i, "coir"],
];

const CARE = /bring indoors[^.;)]*|hand wash[^.;)]*|machine washable[^.;)]*|nicht frostfest|ne résiste pas au gel/i;

type MockState = { calls: number; failed: number; noCredit: number; rateLimited: boolean; truncated: boolean; badJson: boolean };
const state: MockState = { calls: 0, failed: 0, noCredit: 0, rateLimited: false, truncated: false, badJson: false };

export function resetMockState() {
  Object.assign(state, { calls: 0, failed: 0, noCredit: 0, rateLimited: false, truncated: false, badJson: false });
}

function modes() {
  return (process.env.MOCK_AI_MODE ?? "").split(",").map((m) => m.trim()).filter(Boolean);
}

function fieldOf(header: string) {
  return matchHeader(header)?.field;
}

function sentences(text: string) {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

function draftFor(product: ProductInput, invent: boolean, translate: boolean): ProductDraft {
  const cells = product.sourceRows.flatMap((r) => Object.entries(r.cells).map(([column, text]) => ({ row: r.row, column, text })));
  const first = (field: string) => cells.find((c) => fieldOf(c.column) === field)?.text;

  const sourceTitle = first("title");
  const description = first("description");
  const allText = cells.map((c) => c.text).join(" ");

  const title = sourceTitle ?? (description ? description.split(/[.,]/)[0].slice(0, 60) : "Untitled product");
  const category = CATEGORY_KEYWORDS.find(([pattern]) => pattern.test(`${sourceTitle ?? ""} ${description ?? ""}`))?.[1];

  const attributes: Record<string, string> = {};
  const material = MATERIALS.find(([pattern]) => pattern.test(allText))?.[1];
  if (material) attributes.material = material;
  const care = allText.match(CARE)?.[0];
  if (care) attributes.care = care.trim();

  // One claim per risky claim the supplier actually makes, quoting the sentence it's in
  const claims: ProductDraft["claims"] = [];
  const claimed = new Set<string>();
  for (const cell of cells) {
    for (const sentence of sentences(cell.text)) {
      for (const mention of findMentions(sentence)) {
        if (mention.negated || claimed.has(mention.concept.id)) continue;
        claimed.add(mention.concept.id);
        claims.push({ text: mention.concept.id, row: cell.row, column: cell.column, quote: sentence });
      }
    }
  }

  let descriptionHtml = `<p>${escapeHtml(description ?? title)}</p>`;
  let finalTitle = title;
  if (translate && (product.language === "de" || product.language === "fr")) {
    finalTitle = `${title} (in English)`;
    // One sentence, so no German sentence survives on its own (which the translation check would rightly flag)
    descriptionHtml = `<p>English version of the supplier's text: ${escapeHtml((description ?? title).replace(/[.!?]\s+/g, ", "))}</p>`;
  }
  if (invent) {
    claims.push({ text: "dishwasher-safe", row: cells[0]?.row ?? 0, column: cells[0]?.column ?? "", quote: "Dishwasher safe." });
    const denied = cells.flatMap((c) => sentences(c.text).map((s) => ({ ...c, s }))).find((c) => /not frost-proof/i.test(c.s));
    if (denied) claims.push({ text: "frost-proof", row: denied.row, column: denied.column, quote: denied.s });
    descriptionHtml += "<p>Dishwasher safe and built to last.</p>";
  }

  const tags = [...new Set([...normalizeForMatch(title).split(" ").filter((w) => w.length > 3), material].filter(Boolean))].slice(0, 6) as string[];
  const confidence: Record<string, number> = {
    title: sourceTitle ? 95 : 55,
    // Only a name: the one-line description just restates it, which is short but right
    description: description ? 85 : sourceTitle ? 80 : 50,
    category: category ? 90 : 40,
    tags: 80,
  };
  for (const name of Object.keys(attributes)) confidence[`attributes.${name}`] = 85;

  const thin = !sourceTitle && !description;
  return {
    key: product.key,
    title: finalTitle,
    description_html: descriptionHtml,
    category: category ?? "Other",
    tags,
    attributes,
    claims,
    confidence,
    needs_review: thin,
    review_reason: thin ? "The supplier gave no name or description" : null,
  };
}

function fakeTranslation(product: TranslateInput["products"][number], locale: string, active: string[]): TranslatedProduct {
  const { fields } = product;
  const marker = `[${locale.toUpperCase()}]`;
  if (active.includes("notranslate")) {
    return {
      key: product.key,
      ...fields,
      attributes: fields.attributes && Object.fromEntries(Object.entries(fields.attributes).map(([k, v]) => [k, { label: k, value: v }])),
      options: fields.options && Object.fromEntries(Object.entries(fields.options).map(([k, v]) => [k, { label: k, values: Object.fromEntries(v.map((x) => [x, x])) }])),
    };
  }
  const mark = (text: string) => text.split(/(?<=[.!?])\s+/).map((s) => (s.trim() ? `${marker} ${s}` : s)).join(" ");
  let description = fields.description_html?.replace(/>([^<]+)</g, (_m, text: string) => `>${mark(text)}<`);
  if (description && active.includes("invent")) {
    const extra = locale === "de" ? " Frostfest und spülmaschinenfest." : " Ingélif et passe au lave-vaisselle.";
    description = description.replace(/<\/(p|li)>(?![\s\S]*<\/(p|li)>)/, `${extra}</$1>`);
  }
  const translated: TranslatedFields = {
    title: fields.title && `${fields.title} ${marker}`,
    description_html: description,
    tags: fields.tags?.map((t) => `${t} ${locale}`),
    attributes: fields.attributes && Object.fromEntries(Object.entries(fields.attributes).map(([k, v]) => [k, { label: `${k} ${marker}`, value: `${v} ${marker}` }])),
    options: fields.options && Object.fromEntries(Object.entries(fields.options).map(([k, v]) => [k, { label: `${k} ${marker}`, values: Object.fromEntries(v.map((x) => [x, x])) }])),
  };
  return { key: product.key, ...Object.fromEntries(Object.entries(translated).filter(([, v]) => v !== undefined)) };
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const mockProvider: AiProvider = {
  name: "mock",
  modelFor: (tier: AiTier) => `mock-${tier}`,
  async generate(request: AiRequest): Promise<AiResult> {
    state.calls++;
    const active = modes();
    const failLimit = Number(active.find((m) => m.startsWith("fail:"))?.split(":")[1] ?? 0);
    if (state.failed < failLimit) {
      state.failed++;
      throw new AiTemporaryError("Mock AI: provider overloaded (503)");
    }
    const noCreditLimit = Number(active.find((m) => m.startsWith("nocredit:"))?.split(":")[1] ?? 0);
    if (state.noCredit < noCreditLimit) {
      state.noCredit++;
      throw new AiOutOfCreditError("Mock AI: the account is out of credit (402)");
    }
    if (active.includes("ratelimit") && !state.rateLimited) {
      state.rateLimited = true;
      throw new AiRateLimitError("Mock AI: too many requests (429)", 2_000);
    }

    const products =
      request.purpose === "translate"
        ? (request.input as TranslateInput).products.map((p) => fakeTranslation(p, (request.input as TranslateInput).locale, active))
        : (request.input as BuildInput).products.map((p) => draftFor(p, active.includes("invent"), !active.includes("notranslate")));
    let text = JSON.stringify({ products });
    let truncated = false;
    if (active.includes("truncate") && !state.truncated && products.length > 1) {
      state.truncated = true;
      truncated = true;
      text = text.slice(0, Math.floor(text.length / 2));
    } else if (active.includes("badjson") && !state.badJson) {
      state.badJson = true;
      text = `Here are your products: ${text.slice(0, 40)}`;
    }

    return {
      text,
      model: mockProvider.modelFor(request.tier),
      inputTokens: Math.ceil(JSON.stringify(request.input).length / 4),
      outputTokens: Math.ceil(text.length / 4),
      truncated,
    };
  },
};
