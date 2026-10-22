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
  { id: "rust-resistant", phrases: ["rust resistant", "rustproof", "rust proof", "rostbestandig", "rostfrei", "resistant a la rouille", "inoxydable", "stainless"] },
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

export type Mention = { concept: ClaimConcept; phrase: string; negated: boolean };

// German and French change word endings ("frostfester Topf", "résistante au gel"). A word with one of these
// endings added still counts as the word itself
const ENDINGS = /^(e|er|es|en|em|n|s)$/;
const sameWord = (word: string, part: string) => word === part || (part.length >= 4 && word.startsWith(part) && ENDINGS.test(word.slice(part.length)));

// Every risky claim the text makes or denies
export function findMentions(text: string): Mention[] {
  // Each word with the number of the clause it's in (clauses end at commas, full stops, brackets...)
  const words = text.split(/[,;:.!?()[\]]/).flatMap((clause, n) =>
    normalizeForMatch(clause)
      .split(" ")
      .filter(Boolean)
      .map((word) => ({ word, clause: n })),
  );
  const found: { concept: ClaimConcept; phrase: string; start: number; end: number }[] = [];
  for (const concept of CLAIM_CONCEPTS) {
    for (const phrase of concept.phrases) {
      const parts = phrase.split(" ");
      for (let i = 0; i + parts.length <= words.length; i++) {
        if (parts.every((p, k) => sameWord(words[i + k].word, p))) found.push({ concept, phrase, start: i, end: i + parts.length });
      }
    }
  }
  return found.map(({ concept, phrase, start }) => {
    // A negation that already went to a claim in an earlier clause stops there: in "not dishwasher safe, hand wash
    // only" the "not" is about the dishwasher alone. Within one clause it reaches on: "not organic or recycled"
    const clause = words[start].clause;
    const used = found.filter((m) => m.end <= start && words[m.end - 1].clause < clause).map((m) => words[m.end - 1].clause);
    const before = words.slice(Math.max(0, start - NEGATION_REACH), start).filter((w) => w.clause > Math.max(-1, ...used));
    return { concept, phrase, negated: before.some((w) => NEGATIONS.has(w.word)) };
  });
}

// How a claim is shown to the merchant: "fsc-certified" -> "FSC certified", "bpa-free" -> "BPA-free"
export function claimLabel(id: string): string {
  return id.replace(/-certified$/, " certified").replace(/^(fsc|gots|bpa|uv)\b/, (s) => s.toUpperCase());
}

// The risky claims a text actually makes (not the ones it denies)
export function claimedConcepts(text: string): Set<string> {
  return new Set(findMentions(text).filter((m) => !m.negated).map((m) => m.concept.id));
}
