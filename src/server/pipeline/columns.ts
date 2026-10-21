import { CURRENCY_CODES } from "./clean/price";
import type { ColumnHints, Field, SheetFormat } from "./types";

// Header names we recognise exactly, in English, German and French. Matching ignores case, accents and punctuation
const ALIASES: Record<Field, string[]> = {
  sku: [
    "sku", "supplier sku", "item sku", "variant sku", "article number", "article no", "art nr", "art no",
    "artikelnummer", "artikel nr", "item number", "item no", "item code", "product code", "reference", "ref",
    "referenz", "code", "code article",
  ],
  parentSku: [
    "parent sku", "parent", "parent id", "parent ref", "group", "group id", "product group", "model", "style",
    "handle", "produktgruppe", "modell", "elternartikel", "famille", "modele", "sku parent",
  ],
  title: [
    "product name", "name", "title", "product title", "product", "item name", "item", "produktname",
    "bezeichnung", "artikelname", "artikelbezeichnung", "titel", "nom", "nom du produit", "designation", "titre",
    "libelle",
  ],
  description: [
    "description", "desc", "long description", "product description", "beschreibung", "produktbeschreibung",
    "artikelbeschreibung", "description produit", "description longue", "body html", "body",
  ],
  color: ["colour", "color", "farbe", "couleur", "colourway", "colorway", "farbton", "teinte"],
  size: [
    "size", "sizes", "dimensions", "dimension", "dims", "groesse", "grosse", "masse", "abmessungen", "abmessung",
    "taille", "format", "measurements",
  ],
  weight: ["weight", "net weight", "shipping weight", "gewicht", "nettogewicht", "poids", "poids net"],
  material: ["material", "materials", "werkstoff", "materiau", "matiere"],
  price: [
    "price", "retail price", "regular price", "list price", "selling price", "unit price", "rrp", "msrp",
    "price incl vat", "variant price", "preis", "vk", "vk preis", "verkaufspreis", "einzelpreis", "uvp", "prix",
    "prix de vente", "prix unitaire", "prix public",
  ],
  currency: ["currency", "curr", "waehrung", "wahrung", "devise", "monnaie"],
  notes: [
    "notes", "note", "supplier notes", "comments", "comment", "remarks", "bemerkung", "bemerkungen", "hinweis",
    "hinweise", "anmerkungen", "remarques", "remarque", "commentaire", "commentaires",
  ],
  image: [
    "image", "images", "image file", "image name", "image url", "image src", "photo", "photos", "picture", "img",
    "bild", "bilder", "foto", "fotos", "photo url",
  ],
  category: ["category", "categories", "product category", "kategorie", "kategorien", "warengruppe", "categorie", "categories produit"],
  brand: ["brand", "vendor", "manufacturer", "marke", "hersteller", "marque", "fabricant"],
};

// When a header isn't an exact match, a known word inside it is enough ("RRP incl. VAT" is a price).
// Each rule also lists words that rule it out: "Trade price" is what the merchant pays, not what they sell for,
// "Pack size" is a quantity, "Image position" isn't an image
type Rule = { field: Field; words: string[]; unless?: string[]; unit?: string };
const RULES: Rule[] = [
  {
    field: "price",
    words: ["price", "preis", "prix", "rrp", "msrp", "uvp"],
    unless: [
      // what the merchant pays
      "trade", "cost", "wholesale", "purchase", "buying", "einkauf", "einkaufspreis", "ek", "achat", "net", "netto",
      // discounts and old prices: not the normal selling price
      "sale", "compare", "promo", "aktion", "aktionspreis", "angebot", "discount", "special", "offer", "reduced", "was",
    ],
  },
  { field: "sku", words: ["sku"], unless: ["parent"] },
  { field: "parentSku", words: ["parent"] },
  { field: "description", words: ["description", "beschreibung", "body"], unless: ["short", "kurz", "courte"] },
  { field: "color", words: ["colour", "color", "farbe", "couleur", "colourway", "colorway"] },
  {
    field: "size",
    words: ["size", "dims", "dimensions", "dimension", "groesse", "grosse", "masse", "abmessungen", "taille", "measurements"],
    unless: ["pack", "case", "carton", "box", "shipping", "package", "packaging", "verpackung", "colis", "emballage", "qty", "quantity", "inner", "outer"],
  },
  { field: "weight", words: ["grams", "gramm", "grammes"], unit: "g" },
  { field: "weight", words: ["weight", "gewicht", "poids"] },
  { field: "category", words: ["category", "categories", "kategorie", "categorie"] },
  { field: "image", words: ["image", "images", "img", "photo", "picture", "bild", "foto"], unless: ["position", "alt", "count", "width", "height", "caption", "credit"] },
  { field: "brand", words: ["brand", "vendor", "marke", "marque", "manufacturer", "hersteller"] },
  { field: "notes", words: ["notes", "note", "comments", "comment", "remarks", "bemerkung", "hinweis", "remarque", "commentaire"] },
  { field: "currency", words: ["currency", "waehrung", "wahrung", "devise"] },
  { field: "material", words: ["material", "materials", "werkstoff", "materiau", "matiere"] },
];

// Used only when nothing better exists. In ERP exports "Item Desc" is usually the product's name;
// if the sheet has a real name column it's a second description. A "Type" column is a category only
// if there's no category column (in WooCommerce exports "Type" means simple/variable, not a category)
const FALLBACKS: { names: string[]; fields: Field[] }[] = [
  { names: ["item desc", "item description", "short description", "short desc", "kurzbeschreibung", "artikeltext", "description courte"], fields: ["title", "description"] },
  { names: ["type", "product type", "produkttyp", "typ"], fields: ["category"] },
];

const WEIGHT_UNITS = new Set(["kg", "g", "lb", "lbs", "oz"]);
const SIZE_UNITS = new Set(["cm", "mm", "m", "in", "inch", "inches"]);

export function normalizeHeader(header: string) {
  return header
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const LOOKUP = new Map<string, Field>();
for (const [field, names] of Object.entries(ALIASES) as [Field, string[]][]) {
  for (const name of names) LOOKUP.set(normalizeHeader(name), field);
}

// "Price (EUR)" -> { name: "price", unit: "eur" }. Also handles "Price EUR" and "Weight in kg"
function splitUnit(header: string): { name: string; unit: string | null } {
  const inBrackets = header.match(/^(.*?)[([](.+?)[)\]]\s*$/);
  if (inBrackets) return { name: normalizeHeader(inBrackets[1]), unit: normalizeHeader(inBrackets[2]) };

  const words = normalizeHeader(header).split(" ");
  const last = words.at(-1) ?? "";
  if (words.length > 1 && (CURRENCY_CODES.has(last.toUpperCase()) || WEIGHT_UNITS.has(last) || SIZE_UNITS.has(last))) {
    const rest = words.slice(0, -1).filter((w) => w !== "in");
    return { name: rest.join(" "), unit: last };
  }
  return { name: words.join(" "), unit: null };
}

// How sure we are about a header: 1 = exact name, 2 = known word inside it, 3 = only if nothing better
export type HeaderMatch = { field: Field; unit: string | null; rank: 1 | 2 | 3; fallbackFields?: Field[] };

export function matchHeader(header: string): HeaderMatch | null {
  const full = normalizeHeader(header);
  if (!full || OPTION_COLUMN.test(full)) return null;
  const { name, unit } = splitUnit(header);

  const exact = LOOKUP.get(full) ?? LOOKUP.get(name);
  if (exact) return { field: exact, unit, rank: 1 };

  const words = new Set(name.split(" "));
  for (const rule of RULES) {
    if (!rule.words.some((w) => words.has(w))) continue;
    if (rule.unless?.some((w) => words.has(w))) return null;
    return { field: rule.field, unit: rule.unit ?? unit, rank: 2 };
  }

  for (const fallback of FALLBACKS) {
    if (fallback.names.includes(name)) return { field: fallback.fields[0], unit, rank: 3, fallbackFields: fallback.fields };
  }
  return null;
}

// "Option1 Name", "Option1 Value", "Attribute 1 name", "Attribute 1 value(s)"
const OPTION_COLUMN = /^(?:option|attribute|attr|merkmal|eigenschaft)\s*(\d+)\s+(name|value|values|value s|wert|werte)$/;

function findOptionColumns(headers: string[]) {
  const pairs = new Map<string, { name?: number; value?: number }>();
  headers.forEach((header, index) => {
    const match = normalizeHeader(header).match(OPTION_COLUMN);
    if (!match) return;
    const pair = pairs.get(match[1]) ?? {};
    if (match[2] === "name") pair.name = index;
    else pair.value = index;
    pairs.set(match[1], pair);
  });
  return [...pairs.values()].filter((p): p is { name: number; value: number } => p.name !== undefined && p.value !== undefined);
}

function detectFormat(headers: string[]): SheetFormat {
  const has = (name: string) => headers.some((h) => normalizeHeader(h) === name);
  if (has("handle") && (has("variant sku") || has("variant price"))) return "shopify";
  if (has("id") && has("type") && has("parent") && (has("regular price") || has("attribute 1 name"))) return "woocommerce";
  return "generic";
}

export type ColumnMapping = {
  // Our field -> column index
  columns: Partial<Record<Field, number>>;
  hints: ColumnHints;
  unmapped: number[];
  optionColumns: { name: number; value: number }[];
  format: SheetFormat;
};

export function mapColumns(headers: string[]): ColumnMapping {
  const format = detectFormat(headers);
  const optionColumns = findOptionColumns(headers);
  const optionIndexes = new Set(optionColumns.flatMap((p) => [p.name, p.value]));

  // Collect every candidate, then give each field its best one (lowest rank, then leftmost column)
  const candidates = headers
    .map((header, index) => ({ index, match: header.trim() && !optionIndexes.has(index) ? matchHeader(header) : null }))
    .filter((c): c is { index: number; match: HeaderMatch } => c.match !== null)
    .sort((a, b) => a.match.rank - b.match.rank || a.index - b.index);

  const columns: Partial<Record<Field, number>> = {};
  const units: Partial<Record<Field, string | null>> = {};
  const used = new Set<number>();
  for (const { index, match } of candidates) {
    const field = (match.fallbackFields ?? [match.field]).find((f) => columns[f] === undefined);
    if (!field) continue;
    columns[field] = index;
    units[field] = match.unit;
    used.add(index);
  }

  const hints: ColumnHints = {};
  const priceUnit = units.price?.toUpperCase();
  if (priceUnit && CURRENCY_CODES.has(priceUnit)) hints.priceCurrency = priceUnit;
  if (units.weight && WEIGHT_UNITS.has(units.weight)) hints.weightUnit = units.weight;
  if (units.size && SIZE_UNITS.has(units.size)) hints.sizeUnit = units.size;

  const unmapped = headers.map((_, i) => i).filter((i) => !used.has(i) && !optionIndexes.has(i) && headers[i].trim());
  return { columns, hints, unmapped, optionColumns, format };
}

// How many cells in this row look like headers we know
export function headerScore(cells: string[]) {
  return cells.filter((c) => c.trim() && (matchHeader(c) || OPTION_COLUMN.test(normalizeHeader(c)))).length;
}
