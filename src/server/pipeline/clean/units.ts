import { cleanText } from "./text";

const GRAMS_PER: Record<string, number> = {
  kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000,
  g: 1, gr: 1, gram: 1, grams: 1, gramm: 1, gramme: 1, grammes: 1,
  lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237,
  oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
};

const MM_PER: Record<string, number> = {
  mm: 1, cm: 10, m: 1000,
  in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4, "''": 25.4, "”": 25.4, "″": 25.4,
};
// Metric lengths keep the supplier's unit, only inches become cm
const METRIC = new Set(["mm", "cm", "m"]);

// More than this is almost certainly a typo or the wrong unit
const MAX_GRAMS = 2_000_000;

function toNumber(text: string) {
  return Number(text.replace(",", "."));
}

export type WeightResult = { ok: true; grams: number } | { ok: false; reason: string };

// "1,8 kg" -> 1800, "2.2 lbs" -> 998, "900 g" -> 900
export function parseWeight(raw: string | null | undefined, unitHint?: string): WeightResult | null {
  const text = cleanText(raw);
  if (!text) return null;

  const match = text.toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*([a-z]+)?\.?$/);
  if (!match) return { ok: false, reason: `Weight "${text}" isn't a number with a unit` };

  const unit = match[2] ?? unitHint;
  if (!unit) return { ok: false, reason: `Weight "${text}" has no unit (kg, g or lbs?)` };
  const factor = GRAMS_PER[unit];
  if (!factor) return { ok: false, reason: `Weight "${text}" has an unknown unit` };

  const grams = Math.round(toNumber(match[1]) * factor);
  if (grams > MAX_GRAMS) return { ok: false, reason: `Weight "${text}" is too heavy to be right` };
  return { ok: true, grams };
}

export type SizeResult = {
  // What the merchant and shopper see, e.g. "20.3 cm", "100 m"
  text: string;
  // Lengths in millimetres, null for volumes and labels like "XL"
  mm: number[] | null;
  // Set when the size looks wrong, e.g. a number with no unit
  problem?: string;
};

function formatCm(mm: number) {
  const cm = mm / 10;
  return Number.isInteger(cm) ? String(cm) : cm.toFixed(1);
}

const LENGTH_UNIT = /(mm|cm|m|inches|inch|in|"|''|”|″)/;
const PART = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*${LENGTH_UNIT.source}?$`);

// Inches become cm: "8 in" -> "20.3 cm", "12\"" -> "30.5 cm". Metric lengths keep their unit, tidied: "100 m",
// "1,5 m" -> "1.5 m", "150 x 45 x 85 cm" -> "150 × 45 × 85 cm". Volumes and labels stay as they are: "350 ml", "XL".
// The mm list has every length in millimetres, so "100 cm" and "1 m" can still be compared
export function parseSize(raw: string | null | undefined, unitHint?: string): SizeResult | null {
  let text = cleanText(raw);
  if (!text) return null;

  // Drop labels in front of the value: "Größe 15 cm", "Size: M"
  text = text.replace(/^(größe|groesse|grösse|gr\.|size|taille|maße|masse|dimensions?|abmessungen)\s*:?\s*/i, "");

  let prefix = "";
  const diameter = text.match(/^(ø|⌀|dia\.?|diameter|durchmesser)\s*/i);
  if (diameter) {
    prefix = "Ø ";
    text = text.slice(diameter[0].length);
  }

  const volume = text.match(/^(\d+(?:[.,]\d+)?)\s*(ml|cl|l|liter|litre|liters|litres)$/i);
  if (volume) {
    const unit = volume[2].toLowerCase() === "ml" ? "ml" : volume[2].toLowerCase() === "cl" ? "cl" : "L";
    return { text: `${volume[1].replace(",", ".")} ${unit}`, mm: null };
  }

  const parts = text.toLowerCase().split(/\s*[x×*]\s*/);
  const parsed = parts.map((p) => p.match(PART));
  if (parsed.every(Boolean)) {
    // A unit at the end applies to every part: "150 x 45 x 85 cm"
    const lastUnit = parsed.at(-1)![2] ?? unitHint;
    if (!lastUnit) return { text: prefix + text, mm: null, problem: `Size "${text}" has no unit (cm or inches?)` };
    const lengths = parsed.map((m) => {
      const unit = m![2] ?? lastUnit;
      const mm = Math.round(toNumber(m![1]) * MM_PER[unit]);
      return METRIC.has(unit) ? { value: String(toNumber(m![1])), unit, mm } : { value: formatCm(mm), unit: "cm", mm };
    });
    // One unit is written once at the end ("150 × 45 × 85 cm"), mixed units next to each part ("50 cm × 1 m")
    const sameUnit = lengths.every((l) => l.unit === lengths[0].unit);
    const shown = sameUnit ? `${lengths.map((l) => l.value).join(" × ")} ${lengths[0].unit}` : lengths.map((l) => `${l.value} ${l.unit}`).join(" × ");
    return { text: prefix + shown, mm: lengths.map((l) => l.mm) };
  }

  // A label like "XL" or "One size"
  return { text: prefix + text, mm: null };
}
