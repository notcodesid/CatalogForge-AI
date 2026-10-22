// What the Products tab and the review screen read from and send to the API. The shapes mirror the route
// handlers' JSON (dates arrive as strings). Kept apart from the server modules, which would ship database code
// to the browser

export type ProductStatus = "needs_review" | "ready" | "approved";
export type TranslationStatus = "pending" | "done" | "failed";

// One row of GET /api/products
export type ProductRow = {
  id: string;
  handle: string;
  title: string;
  status: ProductStatus;
  category: string | null;
  lowestConfidence: number | null;
  confidence: Record<string, number>;
  reviewReason: string | null;
  minPriceCents: number | null;
  maxPriceCents: number | null;
  // null when there's no price, or when the variants use different currencies (see currencies)
  currency: string | null;
  currencies: string[];
  variantCount: number;
  variantsWithoutPrice: number;
  thumbnailUrl: string | null;
  translations: Record<string, TranslationStatus>;
  editedFields: string[];
  lastImportId: string | null;
  updatedAt: string;
  deletedAt: string | null;
};

export type ProductList = { total: number; page: number; pageSize: number; pages: number; products: ProductRow[] };

export type Claim = { text: string; source: string; quote: string };

export type Variant = {
  id: string;
  sku: string;
  options: Record<string, string>;
  priceCents: number | null;
  currency: string | null;
  weightGrams: number | null;
  position: number;
};

export type ProductPhoto = { id: string; fileName: string; sku: string | null; width: number | null; height: number | null; url: string; thumbnailUrl: string };

export type SourceRow = {
  rowNumber: number;
  status: string;
  reason: string | null;
  raw: Record<string, string>;
  cleaned: {
    sku: string | null;
    title: string | null;
    priceCents: number | null;
    currency: string | null;
    size: string | null;
    color: string | null;
    weightGrams: number | null;
    role: string;
    issues: { severity: "review" | "info"; message: string }[];
  } | null;
};

// GET /api/products/:id
export type ProductDetail = {
  id: string;
  handle: string;
  status: ProductStatus;
  title: string;
  descriptionHtml: string;
  category: string | null;
  tags: string[];
  attributes: Record<string, string>;
  claims: Claim[];
  confidence: Record<string, number>;
  lowestConfidence: number | null;
  reviewReason: string | null;
  reviewReasons: string[];
  contentReviewReasons: string[];
  editedFields: string[];
  model: string | null;
  promptVersion: string | null;
  approvedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastImport: { id: string; fileName: string; createdAt: string } | null;
  variants: Variant[];
  photos: ProductPhoto[];
  sourceRows: SourceRow[];
  // The supplier's text exactly as the AI saw it when it wrote the listing
  writtenFrom: { key: string; language: string; sourceRows: { row: number; cells: Record<string, string> }[] } | null;
  translations: { locale: string; enabled: boolean; status: TranslationStatus | null; error: string | null }[];
};

export type TranslatedField = "title" | "description_html" | "tags" | "attributes" | "options";

export type EnglishFields = {
  title?: string;
  description_html?: string;
  tags?: string[];
  attributes?: Record<string, string>;
  options?: Record<string, string[]>;
};

export type TranslationField = { value: string; writtenBy: "ai" | "merchant"; issue: string | null; upToDate: boolean; outOfDate: boolean };

// GET /api/products/:id/translations
export type ProductTranslations = {
  productId: string;
  title: string;
  english: EnglishFields;
  languages: {
    locale: string;
    enabled: boolean;
    status: TranslationStatus | null;
    error: string | null;
    fields: Partial<Record<TranslatedField, TranslationField>>;
    shown: { title: string; descriptionHtml: string; sources: Partial<Record<TranslatedField, "merchant" | "ai" | "english">>; outOfDate: TranslatedField[] };
  }[];
};

export type BulkApproveResult = { approved: number; alreadyApproved: number; skipped: { id: string; title: string | null; reason: string }[] };

export type EditResult = { changed: string[]; warnings: string[]; product: ProductDetail };

// The shared helpers, so the review screen's files can import everything from here
export { errorMessage, sendJson } from "../api";
