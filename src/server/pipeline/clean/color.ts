import { cleanText } from "./text";

// English colour name -> other spellings and the German/French words for it
const COLORS: Record<string, string[]> = {
  black: ["schwarz", "noir"],
  white: ["weiss", "weiß", "blanc"],
  grey: ["gray", "grau", "gris"],
  anthracite: ["anthrazit"],
  charcoal: ["kohle", "charbon"],
  graphite: ["grafit", "graphit"],
  silver: ["silber", "argent"],
  gold: ["golden", "or"],
  bronze: [],
  copper: ["kupfer", "cuivre"],
  brass: ["messing", "laiton"],
  chrome: ["chrom"],
  zinc: ["zink"],
  red: ["rot", "rouge"],
  burgundy: ["bordeaux", "weinrot"],
  pink: ["rosa", "rose"],
  coral: ["koralle", "corail"],
  peach: ["pfirsich", "peche"],
  orange: [],
  rust: ["rost", "rouille"],
  yellow: ["gelb", "jaune"],
  mustard: ["senf", "moutarde"],
  ochre: ["ocker", "ocre"],
  green: ["grün", "gruen", "vert"],
  olive: ["oliv"],
  sage: ["salbei", "sauge"],
  mint: ["minze", "menthe"],
  teal: ["petrol"],
  turquoise: ["türkis", "tuerkis"],
  blue: ["blau", "bleu"],
  navy: ["navy blue", "marine", "marineblau", "bleu marine"],
  purple: ["lila", "violett", "violet"],
  lilac: ["flieder"],
  lavender: ["lavendel", "lavande"],
  plum: ["pflaume", "prune"],
  brown: ["braun", "marron"],
  taupe: [],
  beige: [],
  cream: ["creme", "crème", "ecru"],
  ivory: ["elfenbein", "ivoire"],
  oat: ["oatmeal", "hafer"],
  sand: [],
  stone: ["stein", "pierre"],
  khaki: [],
  natural: ["natur", "naturel", "nature", "natural wood"],
  terracotta: ["terrakotta", "terre cuite"],
  clear: ["transparent", "klar"],
  multicolour: ["multicolor", "multi", "bunt", "mehrfarbig", "multicolore"],
};

const SHADES: Record<string, string> = {
  dark: "dark", dunkel: "dark", fonce: "dark", light: "light", hell: "light", clair: "light",
};

function normalize(word: string) {
  return word.toLowerCase().replace(/ß/g, "ss").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();
}

const LOOKUP = new Map<string, string>();
for (const [english, others] of Object.entries(COLORS)) {
  for (const name of [english, ...others]) LOOKUP.set(normalize(name), english);
}
const KNOWN = [...LOOKUP.keys()];

// Typo distance where swapping two neighbouring letters counts as one typo ("gery" -> "grey" = 1),
// like a person would count it (Levenshtein would say 2)
export function typoDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Allow 1 typo in short names and 2 in long ones ("terracota" -> "terracotta").
// Very short words must match exactly, otherwise "rot" and "rose" get mixed up
function closest(word: string): string | null {
  const allowed = word.length >= 7 ? 2 : word.length >= 4 ? 1 : 0;
  let best: string | null = null;
  let bestDistance = Infinity;
  let tie = false;
  for (const known of KNOWN) {
    const d = typoDistance(word, known);
    if (d < bestDistance) {
      best = known;
      bestDistance = d;
      tie = false;
    } else if (d === bestDistance && LOOKUP.get(known) !== LOOKUP.get(best!)) {
      tie = true;
    }
  }
  if (best === null || bestDistance > allowed || tie) return null;
  return LOOKUP.get(best)!;
}

// Exact names only, no typo matching. Used to strip colour words from product names
export function isColorWord(word: string): boolean {
  return LOOKUP.has(normalize(word));
}

export function matchColor(word: string): string | null {
  const key = normalize(word);
  return LOOKUP.get(key) ?? closest(key);
}

// One colour, optionally with a shade: "Dark Grey", "hell blau"
function matchOne(text: string): string | null {
  const direct = matchColor(text);
  if (direct) return direct;
  const words = normalize(text).split(/[\s-]+/);
  if (words.length === 2 && SHADES[words[0]]) {
    const base = matchColor(words[1]);
    if (base) return `${SHADES[words[0]]} ${base}`;
  }
  return null;
}

export type ColorResult = { value: string; known: boolean; source: string };

// "terracota" -> "terracotta", "Grau" -> "grey", "Natural/Grey" -> "natural/grey".
// Anything we don't recognise stays as the supplier wrote it, in lowercase
export function normalizeColor(raw: string | null | undefined): ColorResult | null {
  const source = cleanText(raw);
  if (!source) return null;

  const single = matchOne(source);
  if (single) return { value: single, known: true, source };

  // Two colours in one cell: "Natural/Grey", "black & white"
  const parts = source.split(/\s*(?:\/|&|\+|,|\band\b|\bund\b|\bet\b)\s*/i).filter(Boolean);
  if (parts.length > 1) {
    const matched = parts.map(matchOne);
    if (matched.every(Boolean)) return { value: matched.join("/"), known: true, source };
  }

  return { value: source.toLowerCase(), known: false, source };
}
