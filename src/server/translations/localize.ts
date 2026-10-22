import { cleanDescription } from "@/server/pipeline/clean/html";
import { translateCategory } from "./categories";
import { decodeValue, englishFields, fieldHashes, type Locale, TRANSLATED_FIELDS, type TranslatedField, type TranslatedFields } from "./fields";

// What a shopper reads in their language, field by field: the merchant's own translation if there is one (it
// always wins, even when the English changed since: it's then flagged "out of date" for the merchant), else the
// AI's translation if it was made from the current English and passed every check, else the English. Never an
// AI call: everything here was translated ahead of time

export type TranslationRow = { field: string; value: string; sourceHash: string; writtenBy: "ai" | "merchant"; issue: string | null };
export type FieldSource = "merchant" | "ai" | "english";

type ProductText = { title: string; descriptionHtml: string; tags: string[]; attributes: Record<string, string>; category: string | null };

// "material" -> "Material", "color" -> "Colour"
function englishLabel(key: string) {
  if (key.toLowerCase() === "color") return "Colour";
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
}

// Meta title and description for search engines, cut from what the shopper reads (nothing new is written)
export function seoFields(title: string, descriptionHtml: string) {
  const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);
  const text = cleanDescription(descriptionHtml)?.text ?? "";
  return { metaTitle: cut(title, 60), metaDescription: cut(text || title, 155) };
}

export function localizeProduct(product: ProductText, variants: { options: Record<string, string> }[], rows: TranslationRow[], locale: Locale | "en") {
  const english = englishFields(product, variants);
  const hashes = fieldHashes(english);
  const sources: Partial<Record<TranslatedField, FieldSource>> = {};
  const outOfDate: TranslatedField[] = [];

  const pick = <F extends TranslatedField>(field: F): TranslatedFields[F] | undefined => {
    sources[field] = "english";
    if (locale === "en" || english[field] === undefined) return undefined;
    const row = rows.find((r) => r.field === field);
    if (row?.writtenBy === "merchant") {
      sources[field] = "merchant";
      if (row.sourceHash !== hashes[field]) outOfDate.push(field);
      return decodeValue(field, row.value);
    }
    if (row && !row.issue && row.sourceHash === hashes[field]) {
      sources[field] = "ai";
      return decodeValue(field, row.value);
    }
    return undefined;
  };

  const title = pick("title") ?? product.title;
  const descriptionHtml = pick("description_html") ?? product.descriptionHtml;
  const tags = pick("tags") ?? product.tags;
  const attributeTranslations = pick("attributes");
  const optionTranslations = pick("options");
  for (const field of TRANSLATED_FIELDS) sources[field] ??= "english";

  return {
    locale,
    title,
    descriptionHtml,
    tags,
    category: translateCategory(product.category, locale),
    // Attributes in a fixed order, with the name to show next to each value
    attributes: Object.keys(english.attributes ?? {}).map((key) => ({
      key,
      label: attributeTranslations?.[key]?.label ?? englishLabel(key),
      value: attributeTranslations?.[key]?.value ?? english.attributes![key],
    })),
    // Variant options (size, colour...) with their values: English value -> what the shopper reads
    options: Object.entries(english.options ?? {}).map(([name, values]) => ({
      name,
      label: optionTranslations?.[name]?.label ?? englishLabel(name),
      values: Object.fromEntries(values.map((v) => [v, optionTranslations?.[name]?.values?.[v] ?? v])),
    })),
    seo: seoFields(title, descriptionHtml),
    // Where each field came from, and the merchant's translations whose English changed since
    sources,
    outOfDate,
  };
}
