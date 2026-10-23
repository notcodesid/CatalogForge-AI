// Claims that can get a merchant into trouble if they're wrong ("frost-proof", "organic", "dishwasher-safe").
// Each one lists how suppliers write it in English, German and French. A claim about one of these must be
// backed by the supplier's own words, and not by words that deny it ("not frost-proof", "nicht frostfest")

export type ClaimConcept = { id: string; phrases: string[] };

const CLAIM_CONCEPTS: ClaimConcept[] = [
  // "Frostbeständig" and "résistant au gel" say frost-resistant, the weaker claim. Frost-proof is "frostfest",
  // "frostsicher", "ingélif", "à l'épreuve du gel"
  { id: "frost-proof", phrases: ["frost proof", "frostproof", "frostfest", "frostsicher", "ingelif", "non gelif", "a l epreuve du gel"] },
  {
    id: "frost-resistant",
    phrases: ["frost resistant", "frost tolerant", "frost hardy", "winterhart", "frostbestandig", "frostresistent", "resiste au gel", "resistant au gel"],
  },
  {
    id: "handmade",
    phrases: ["handmade", "hand made", "made by hand", "handcrafted", "hand crafted", "handgemacht", "handgefertigt", "handarbeit", "handwerksarbeit", "handwerklich", "fait main", "fait a la main", "fabrique a la main", "artisanal"],
  },
  { id: "organic", phrases: ["organic", "bio", "biologisch", "biologique", "organique", "oko"] },
  { id: "dishwasher-safe", phrases: ["dishwasher safe", "dishwasher proof", "spulmaschinenfest", "spulmaschinengeeignet", "spulmaschinentauglich", "lave vaisselle"] },
  { id: "microwave-safe", phrases: ["microwave safe", "microwave", "mikrowellengeeignet", "mikrowelle", "micro ondes"] },
  { id: "waterproof", phrases: ["waterproof", "water proof", "wasserdicht", "impermeable"] },
  { id: "water-resistant", phrases: ["water resistant", "water repellent", "wasserabweisend", "deperlant"] },
  { id: "food-safe", phrases: ["food safe", "lebensmittelecht", "contact alimentaire"] },
  { id: "bpa-free", phrases: ["bpa free", "bpa frei", "sans bpa"] },
  { id: "recycled", phrases: ["recycled", "recycelt", "recycle"] },
  { id: "fsc-certified", phrases: ["fsc"] },
  { id: "gots-certified", phrases: ["gots"] },
  { id: "vegan", phrases: ["vegan", "vegane", "vegetalien"] },
  { id: "rust-resistant", phrases: ["rust resistant", "rustproof", "rust proof", "rostbestandig", "rostfrei", "resistant a la rouille"] },
  // A material, but one a listing must not make up: "stainless steel" from a supplier's plain "steel" is a promise.
  // Its own claim, so "Edelstahl" backs "stainless steel" and not the stronger "rust-resistant"
  { id: "stainless-steel", phrases: ["stainless", "edelstahl", "inox", "inoxydable"] },
  { id: "uv-resistant", phrases: ["uv resistant", "uv bestandig", "uv stable"] },
  { id: "eco-friendly", phrases: ["eco friendly", "umweltfreundlich", "ecologique", "sustainable", "nachhaltig"] },
  { id: "non-toxic", phrases: ["non toxic", "nontoxic", "ungiftig", "non toxique"] },
  { id: "hypoallergenic", phrases: ["hypoallergenic", "hypoallergen", "hypoallergenique"] },
  { id: "oven-safe", phrases: ["oven safe", "ovenproof", "oven proof", "backofenfest", "ofenfest", "backofengeeignet", "ofengeeignet", "va au four", "allant au four"] },
  // Care instructions are promises too: a cover that shrinks at 40 °C because the listing said "machine washable"
  {
    id: "machine-washable",
    phrases: ["machine washable", "machine wash", "machine washing", "washing machine", "maschinenwaschbar", "waschmaschinenfest", "waschmaschinengeeignet", "waschmaschine", "maschinenwasche", "lavable en machine", "lavage en machine", "lave linge"],
  },
  {
    id: "hand-wash",
    phrases: ["hand wash", "handwash", "hand washing", "hand washable", "wash by hand", "handwasche", "handwaschbar", "hand waschen", "lavage a la main", "laver a la main", "lavable a la main"],
  },
  { id: "dry-clean", phrases: ["dry clean", "dry cleaning", "chemische reinigung", "chemisch reinigen", "nettoyage a sec", "nettoyer a sec"] },
  { id: "wipe-clean", phrases: ["wipe clean", "wipeable", "damp cloth", "abwischbar", "abwischen", "feucht tuch", "chiffon humide"] },
  { id: "tumble-dry", phrases: ["tumble dry", "tumble dryer", "tumble drying", "trockner", "trocknergeeignet", "seche linge"] },
];

// Words that turn a claim around when they come just before it: "not frost-proof", "nicht frostfest"
const NEGATIONS = new Set(["not", "no", "never", "without", "isnt", "arent", "nicht", "kein", "keine", "keinen", "ohne", "ne", "pas", "sans", "non"]);
const NEGATION_REACH = 4;

// Words near a claim that make it partial: "organic cotton blend", "60% recycled", "Bio-Baumwollmischung", "mélange
// de lin bio". The supplier's partial claim doesn't back the full one: "organic cotton blend" isn't "organic"
const QUALIFIERS = new Set(["blend", "blended", "mix", "mixed", "mixture", "partly", "partially", "contains", "containing", "teilweise", "enthalt", "melange", "partiellement", "contient"]);
const isQualifier = (word: string) => QUALIFIERS.has(word) || word.endsWith("%") || /(?:mischung|anteil)$/.test(word);
const QUALIFIER_REACH = 3;

// Lowercase, no accents, hyphens as spaces: "Frost-proof", "frost proof" and "frostproof" can then be compared
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/n't\b/g, " not")
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}

export type Mention = { concept: ClaimConcept; phrase: string; negated: boolean; qualified: boolean };

// German and French change word endings ("frostfester Topf", "résistante au gel"). A word with one of these
// endings added still counts as the word itself
const ENDINGS = /^(e|er|es|en|em|n|s)$/;
const sameWord = (word: string, part: string) => word === part || (part.length >= 4 && word.startsWith(part) && ENDINGS.test(word.slice(part.length)));

// Every risky claim the text makes or denies
export function findMentions(text: string): Mention[] {
  // Each word with the number of the clause it's in (clauses end at commas, full stops, brackets...) and of the
  // sentence (only full stops, semicolons, colons and brackets end one, not commas)
  const pieces = text.split(/([,;:.!?()[\]])/);
  let sentence = 0;
  const words = pieces.flatMap((piece, i) => {
    if (i % 2 === 1) {
      if (piece !== ",") sentence++;
      return [];
    }
    return normalizeForMatch(piece)
      .split(" ")
      .filter(Boolean)
      .map((word) => ({ word, clause: i / 2, sentence }));
  });
  const found: { concept: ClaimConcept; phrase: string; start: number; end: number }[] = [];
  for (const concept of CLAIM_CONCEPTS) {
    for (const phrase of concept.phrases) {
      const parts = phrase.split(" ");
      for (let i = 0; i + parts.length <= words.length; i++) {
        if (parts.every((p, k) => sameWord(words[i + k].word, p))) found.push({ concept, phrase, start: i, end: i + parts.length });
      }
    }
  }
  return found.map(({ concept, phrase, start, end }) => {
    // A negation that already went to a claim in an earlier clause stops there: in "not dishwasher safe, hand wash
    // only" the "not" is about the dishwasher alone. Within one clause it reaches on: "not organic or recycled". It
    // never reaches into the next sentence: in "durable material (not specified). FSC certified" FSC isn't denied
    const { clause, sentence } = words[start];
    const used = found.filter((m) => m.end <= start && words[m.end - 1].clause < clause).map((m) => words[m.end - 1].clause);
    const before = words
      .slice(Math.max(0, start - NEGATION_REACH), start)
      .filter((w) => w.clause > Math.max(-1, ...used) && w.sentence === sentence);
    const near = words.slice(Math.max(0, start - QUALIFIER_REACH), end + QUALIFIER_REACH).filter((w) => w.clause === clause);
    return { concept, phrase, negated: before.some((w) => NEGATIONS.has(w.word)), qualified: near.some((w) => isQualifier(w.word)) };
  });
}

// How a claim is shown to the merchant: "fsc-certified" -> "FSC certified", "bpa-free" -> "BPA-free",
// "stainless-steel" -> "stainless steel"
export function claimLabel(id: string): string {
  return id.replace(/-(certified|steel)$/, " $1").replace(/^(fsc|gots|bpa|uv)\b/, (s) => s.toUpperCase());
}

// What a supplier's text backs: claims it makes in full, and claims it only makes in part ("organic cotton blend").
// A mention in the listing is backed by a full claim, or by a partial one when it's partial too
export function claimBacking(sourceText: string): (m: Mention) => boolean {
  const made = findMentions(sourceText).filter((m) => !m.negated);
  const full = new Set(made.filter((m) => !m.qualified).map((m) => m.concept.id));
  const partial = new Set(made.filter((m) => m.qualified).map((m) => m.concept.id));
  return (m) => full.has(m.concept.id) || (m.qualified && partial.has(m.concept.id));
}

// The risky claims a text actually makes (not the ones it denies)
export function claimedConcepts(text: string): Set<string> {
  return new Set(findMentions(text).filter((m) => !m.negated).map((m) => m.concept.id));
}
