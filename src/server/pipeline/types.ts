// "review" problems send the product to Needs review. "info" problems are only shown to the merchant
export type IssueSeverity = "review" | "info";

export type Issue = {
  field: string;
  message: string;
  severity: IssueSeverity;
  // Set on issues a later stage may replace, e.g. "currency_assumed" once the product's other sizes are known
  code?: "currency_assumed";
};

// The fields we look for in a supplier sheet
export const FIELDS = [
  "sku",
  "parentSku",
  "title",
  "description",
  "color",
  "size",
  "weight",
  "material",
  "price",
  "currency",
  "notes",
  "image",
  "category",
  "brand",
] as const;

export type Field = (typeof FIELDS)[number];

export type Language = "en" | "de" | "fr" | "unknown";

// What a row is. Most rows are variants (something you can buy). A WooCommerce "variable" row only holds
// the product's shared info, and a Shopify row with nothing but an image adds a photo to its product
export type RowRole = "variant" | "product" | "image";

// One sheet row after cleaning. Stored in import_rows.cleaned
export type CleanedRow = {
  sku: string | null;
  parentSku: string | null;
  title: string | null;
  descriptionHtml: string | null;
  descriptionText: string | null;
  // English, lowercase, e.g. "terracotta"
  color: string | null;
  // What the sheet said, e.g. "terracota"
  colorSource: string | null;
  // e.g. "20.3 cm", "150 × 45 × 85 cm", "350 ml", "XL"
  size: string | null;
  // Lengths in millimetres (one number, or several for W × D × H)
  sizeMm: number[] | null;
  weightGrams: number | null;
  material: string | null;
  priceCents: number | null;
  currency: string | null;
  // No currency anywhere in the row or sheet, so the import's default was used
  currencyAssumed: boolean;
  notes: string | null;
  image: string | null;
  category: string | null;
  brand: string | null;
  language: Language;
  role: RowRole;
  // Variant options other than size and colour, e.g. { Material: "Oak" }
  options: Record<string, string>;
  // Columns we couldn't match to a field. Kept as source text for the AI instead of being dropped
  extra: Record<string, string>;
  issues: Issue[];
  // Set when this row is an exact copy of an earlier row with the same SKU
  duplicateOfRow?: number;
};

// What we learned while reading the file. Stored in imports.parse_info
export type ParseInfo = {
  fileType: "csv" | "xlsx" | "xls";
  encoding?: string;
  delimiter?: string;
  sheetName?: string;
  headerRow: number;
  // Our field -> sheet header
  columns: Partial<Record<Field, string>>;
  unmappedColumns: string[];
  hints: ColumnHints;
  blankRows: number;
  // "shopify" and "woocommerce" exports get extra handling (options, parent rows, photo rows)
  format: SheetFormat;
  // Pairs like "Option1 Name" / "Option1 Value" (Shopify) or "Attribute 1 name" / "Attribute 1 value(s)" (WooCommerce)
  optionColumns: { name: string; value: string }[];
  // WooCommerce: the ID and Type columns, used to link variations to their parent product
  woo?: { idColumn: string; typeColumn: string };
  // Rows that aren't products: notes, footers, section titles. Not counted as sheet rows
  ignoredRows: { rowNumber: number; text: string }[];
};

export type SheetFormat = "generic" | "shopify" | "woocommerce";

// Units or currencies written in a header, e.g. "Price (EUR)" or "Weight (kg)"
export type ColumnHints = {
  priceCurrency?: string;
  weightUnit?: string;
  sizeUnit?: string;
};
