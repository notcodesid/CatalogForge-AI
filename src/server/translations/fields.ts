import { createHash } from "node:crypto";

// The shop's languages besides English
export const LOCALES = ["de", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value);

export const LANGUAGE_NAMES: Record<Locale, string> = { de: "German", fr: "French" };

// What shoppers read, field by field. Each field is translated, cached and redone on its own: when only the
// title changes, only the title is translated again
export const TRANSLATED_FIELDS = ["title", "description_html", "tags", "attributes", "options"] as const;
export type TranslatedField = (typeof TRANSLATED_FIELDS)[number];
export const isTranslatedField = (value: string): value is TranslatedField => (TRANSLATED_FIELDS as readonly string[]).includes(value);

// The English of each field. Empty fields (no tags, no attributes...) are left out: there's nothing to translate
export type EnglishFields = {
  title?: string;
  description_html?: string;
  tags?: string[];
  // Attribute name -> value, e.g. { material: "terracotta" }
  attributes?: Record<string, string>;
  // Variant option name -> its values, e.g. { color: ["sage", "oat"], size: ["45 cm", "50 cm"] }
  options?: Record<string, string[]>;
};

// The translation of each field. Attributes and options also get a translated name for the shopper to read
export type TranslatedFields = {
  title?: string;
  description_html?: string;
  tags?: string[];
  attributes?: Record<string, { label: string; value: string }>;
  options?: Record<string, { label: string; values: Record<string, string> }>;
};

type ProductText = { title: string; descriptionHtml: string; tags: string[]; attributes: Record<string, string> };

export function englishFields(product: ProductText, variants: { options: Record<string, string> }[]): EnglishFields {
  const fields: EnglishFields = {};
  if (product.title.trim()) fields.title = product.title;
  if (product.descriptionHtml.trim()) fields.description_html = product.descriptionHtml;
  if (product.tags.length) fields.tags = [...product.tags];
  if (Object.keys(product.attributes).length) fields.attributes = sorted(product.attributes);
  const options = new Map<string, Set<string>>();
  for (const variant of variants) {
    for (const [name, value] of Object.entries(variant.options)) if (value) options.set(name, (options.get(name) ?? new Set()).add(value));
  }
  if (options.size) fields.options = Object.fromEntries([...options.keys()].sort().map((name) => [name, [...options.get(name)!].sort()]));
  return fields;
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
}

// JSON with keys in a fixed order, so the same content always gives the same fingerprint
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fieldHashes(fields: EnglishFields): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 32)]));
}

export const sameHashes = (a: Record<string, string>, b: Record<string, string>) => stableJson(a) === stableJson(b);

// Translations are stored as text: strings as they are, everything else as JSON
export function encodeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function decodeValue<F extends TranslatedField>(field: F, value: string): NonNullable<TranslatedFields[F]> {
  return (field === "title" || field === "description_html" ? value : JSON.parse(value)) as NonNullable<TranslatedFields[F]>;
}
