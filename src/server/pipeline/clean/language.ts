import type { Language } from "../types";

// Small common words that give a language away. Good enough to tell the AI "this row is in German"
const WORDS: Record<Exclude<Language, "unknown">, Set<string>> = {
  en: new Set(["the", "and", "with", "for", "of", "in", "is", "this", "made", "from", "to", "only", "hand", "not"]),
  de: new Set(["und", "mit", "für", "aus", "der", "die", "das", "den", "dem", "nicht", "ein", "eine", "ist", "im", "zu", "von", "handgemacht", "lieferung"]),
  fr: new Set(["et", "avec", "pour", "le", "la", "les", "des", "une", "un", "du", "en", "fait", "main", "est", "pas"]),
};

export function detectLanguage(texts: (string | null | undefined)[]): Language {
  const text = texts.filter(Boolean).join(" ").toLowerCase();
  if (!text) return "unknown";

  const scores: Record<string, number> = { en: 0, de: 0, fr: 0 };
  for (const word of text.split(/[^\p{L}]+/u)) {
    for (const lang of ["en", "de", "fr"] as const) if (WORDS[lang].has(word)) scores[lang]++;
  }
  // Letters that only show up in one language
  scores.de += (text.match(/[äöüß]/g) ?? []).length;
  scores.fr += (text.match(/[éèêàçùœ]/g) ?? []).length;

  const [best, second] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (best[1] >= 2 && best[1] > second[1]) return best[0] as Language;
  // Short text with no German or French signs at all, like "Watering Can", is English
  if (scores.de === 0 && scores.fr === 0 && /^[\x20-\x7e]*$/.test(text)) return "en";
  return "unknown";
}
