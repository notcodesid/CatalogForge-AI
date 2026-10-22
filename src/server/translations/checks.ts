import { claimedConcepts, normalizeForMatch } from "@/server/ai/claims";
import { cleanDescription } from "@/server/pipeline/clean/html";
import { cleanText } from "@/server/pipeline/clean/text";
import type { EnglishFields, TranslatedField, TranslatedFields } from "./fields";

// Checks a translation against its English in code. The AI is told all of this, but not trusted to do it:
// the HTML tags, every number and unit, codes like FSC or E27 and placeholders like {{count}} must survive,
// a claim must not get stronger ("frost-resistant" must not become "frostfest"), and the text must really be
// translated. Each problem is said in words, for the AI to fix and for the merchant to read

const textOf = (html: string) => cleanDescription(html)?.text ?? cleanText(html) ?? "";

function sortedMatches(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? []).map((m) => m.trim()).sort();
}

// "20 cm", "1.2 kg", "350 ml", "30°C", "5 L", "100%". Not "in": "3 in 1" isn't a unit
const UNIT = /(\d+(?:[.,]\d+)?)\s?(mm|cm|km|m|kg|mg|g|lbs|lb|oz|ml|cl|dl|l|kW|W|V|mAh|°C|°F|%)(?![a-zA-Z])/gi;
// Codes and abbreviations: FSC, GOTS, UV, E27, XL
const CODE = /\b(?:[A-Z]{2,}|[A-Z]+\d+[A-Z\d]*|\d+[A-Z]{2,})\b/g;
// {{count}}, {name}, %s, %1$d
const PLACEHOLDER = /\{\{\s*[\w.]+\s*\}\}|\{[\w.]+\}|%(?:\d+\$)?[sdif]/g;
const TAG = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi;

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function listMissing(english: string[], translated: string[]): string[] {
  const left = [...translated];
  const missing: string[] = [];
  for (const item of english) {
    const at = left.indexOf(item);
    if (at === -1) missing.push(item);
    else left.splice(at, 1);
  }
  return missing;
}

// Problems shared by every piece of text: numbers, units, codes, placeholders
function textProblems(english: string, translated: string): string[] {
  const problems: string[] = [];
  const digits = (t: string) => sortedMatches(t, /\d+/g);
  const missingNumbers = listMissing(digits(english), digits(translated));
  const extraNumbers = listMissing(digits(translated), digits(english));
  if (missingNumbers.length) problems.push(`the number${missingNumbers.length > 1 ? "s" : ""} ${missingNumbers.join(", ")} went missing`);
  if (extraNumbers.length) problems.push(`it has number${extraNumbers.length > 1 ? "s" : ""} the English doesn't (${extraNumbers.join(", ")})`);

  // A unit must stay next to its number: "20 cm" can't become "20 Zoll". Decimal comma or point both fine
  const unitKey = (n: string, u: string) => `${n.replace(",", ".")} ${u.toLowerCase()}`;
  const units = (t: string) => [...t.matchAll(UNIT)].map((m) => unitKey(m[1], m[2])).sort();
  const missingUnits = listMissing(units(english), units(translated));
  if (missingUnits.length && !missingNumbers.length) problems.push(`the unit changed or went missing in ${missingUnits.join(", ")}`);

  const missingCodes = listMissing(sortedMatches(english, CODE), sortedMatches(translated, CODE));
  if (missingCodes.length) problems.push(`${missingCodes.join(", ")} must stay as written`);
  const placeholders = (t: string) => sortedMatches(t, PLACEHOLDER);
  if (!sameList(placeholders(english), placeholders(translated))) problems.push(`the placeholders changed (${placeholders(english).join(", ")})`);
  return problems;
}

// Claims the translation makes that the English doesn't: "frostfest" (frost-proof) for "frost-resistant",
// or "spülmaschinenfest" where the English says "not dishwasher safe"
function strongerClaims(englishText: string, translatedText: string): string[] {
  const english = claimedConcepts(englishText);
  return [...claimedConcepts(translatedText)].filter((c) => !english.has(c));
}

function claimProblem(englishText: string, translatedText: string): string[] {
  const extra = strongerClaims(englishText, translatedText);
  return extra.length ? [`it claims ${extra.join(", ")}, which the English doesn't`] : [];
}

// Everything the English says, to check claims against: a claim anywhere in the English may appear anywhere
function allEnglishText(english: EnglishFields): string {
  return [
    english.title,
    english.description_html && textOf(english.description_html),
    ...(english.tags ?? []),
    ...Object.values(english.attributes ?? {}),
    ...Object.values(english.options ?? {}).flat(),
  ]
    .filter(Boolean)
    .join(". ");
}

function sentenceList(text: string) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(normalizeForMatch)
    .filter((s) => s.split(" ").length >= 6);
}

export function checkField(field: TranslatedField, english: EnglishFields, translated: TranslatedFields): string[] {
  const allEnglish = allEnglishText(english);
  switch (field) {
    case "title": {
      const title = translated.title?.trim() ?? "";
      if (!title) return ["the title is empty"];
      if (title.length > 120) return ["the title is too long"];
      return [...textProblems(english.title ?? "", title), ...claimProblem(allEnglish, title)];
    }
    case "description_html": {
      const englishHtml = english.description_html ?? "";
      const html = cleanDescription(translated.description_html)?.html ?? "";
      if (!html) return ["the description is empty"];
      const problems: string[] = [];
      const tags = (h: string) => [...h.matchAll(TAG)].map((m) => `${m[1]}${m[2].toLowerCase()}`);
      if (!sameList(tags(cleanDescription(englishHtml)?.html ?? ""), tags(html))) problems.push("the HTML tags changed");
      const en = textOf(englishHtml);
      const tr = textOf(html);
      problems.push(...textProblems(en, tr), ...claimProblem(allEnglish, tr));
      if (normalizeForMatch(en) === normalizeForMatch(tr) && en.split(/\s+/).length >= 4) problems.push("it's still in English");
      else {
        const englishSentences = new Set(sentenceList(en));
        const copied = sentenceList(tr).find((s) => englishSentences.has(s));
        if (copied) problems.push("a sentence was left in English");
      }
      if (en.length >= 60 && (tr.length < en.length * 0.4 || tr.length > en.length * 3)) {
        problems.push(`it's much ${tr.length < en.length ? "shorter" : "longer"} than the English`);
      }
      return problems;
    }
    case "tags": {
      const tags = translated.tags ?? [];
      if (!tags.length || tags.some((t) => !t.trim())) return ["tags are missing or empty"];
      return claimProblem(allEnglish, tags.join(". "));
    }
    case "attributes": {
      const want = Object.keys(english.attributes ?? {}).sort();
      const got = translated.attributes ?? {};
      const missing = want.filter((k) => !got[k]?.label?.trim() || !got[k]?.value?.trim());
      if (missing.length) return [`attribute${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not translated`];
      return want.flatMap((k) => [
        ...textProblems(english.attributes![k], got[k].value).map((p) => `${k}: ${p}`),
        ...claimProblem(allEnglish, got[k].value).map((p) => `${k}: ${p}`),
      ]);
    }
    case "options": {
      const problems: string[] = [];
      for (const [name, values] of Object.entries(english.options ?? {})) {
        const got = translated.options?.[name];
        if (!got?.label?.trim()) {
          problems.push(`option ${name} not translated`);
          continue;
        }
        for (const value of values) {
          const tr = got.values?.[value];
          if (!tr?.trim()) problems.push(`option ${name}: "${value}" not translated`);
          else problems.push(...textProblems(value, tr).map((p) => `option ${name} "${value}": ${p}`));
        }
      }
      return problems;
    }
  }
}

// The translation as it's stored: HTML cleaned like supplier HTML (no scripts, no attributes), tags lowercase,
// only the attributes and option values the English has
export function cleanTranslated<F extends TranslatedField>(field: F, english: EnglishFields, translated: TranslatedFields): TranslatedFields[F] {
  switch (field) {
    case "title":
      return (cleanText(translated.title) ?? "") as TranslatedFields[F];
    case "description_html":
      return (cleanDescription(translated.description_html)?.html ?? "") as TranslatedFields[F];
    case "tags":
      return [...new Set((translated.tags ?? []).map((t) => cleanText(t)?.toLowerCase()).filter((t): t is string => Boolean(t)))] as TranslatedFields[F];
    case "attributes": {
      const keys = Object.keys(english.attributes ?? {});
      return Object.fromEntries(
        keys.map((k) => [k, { label: cleanText(translated.attributes?.[k]?.label) ?? k, value: cleanText(translated.attributes?.[k]?.value) ?? "" }]),
      ) as TranslatedFields[F];
    }
    case "options":
      return Object.fromEntries(
        Object.entries(english.options ?? {}).map(([name, values]) => {
          const got = translated.options?.[name];
          return [name, { label: cleanText(got?.label) ?? name, values: Object.fromEntries(values.map((v) => [v, cleanText(got?.values?.[v]) ?? v])) }];
        }),
      ) as TranslatedFields[F];
  }
  throw new Error(`Unknown field ${field}`);
}
