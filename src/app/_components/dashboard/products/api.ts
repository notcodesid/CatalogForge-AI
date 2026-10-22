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
  // The AI wrote a new version of this approved product's listing, waiting for the merchant
  updateWaiting: boolean;
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
  // The merchant typed this price in Edit: a re-upload of the sheet doesn't change it
  priceSetByHand: boolean;
  // The price the supplier's sheet last gave (null: none)
  sheetPriceCents: number | null;
  sheetCurrency: string | null;
  // The currency a price typed in Edit is saved in
  priceCurrency: string;
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
  // What the colour or size column really holds, when the AI renamed it ({ color: "scent" })
  optionNames: Record<string, string>;
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
  // The supplier's text exactly as the AI saw it when it wrote the listing (or the new version, while one waits)
  writtenFrom: { key: string; language: string; sourceRows: { row: number; cells: Record<string, string> }[] } | null;
  // A new listing the AI wrote for this approved product, waiting for the merchant
  newVersion: NewVersion | null;
  translations: { locale: string; enabled: boolean; status: TranslationStatus | null; error: string | null }[];
};

// The parts of a listing the review screen compares
export type ListingField = "title" | "descriptionHtml" | "category" | "tags" | "attributes" | "optionNames" | "claims";

export type NewVersion = {
  title: string;
  descriptionHtml: string;
  category: string | null;
  tags: string[];
  attributes: Record<string, string>;
  claims: Claim[];
  confidence: Record<string, number>;
  optionNames: Record<string, string>;
  // What the AI checks found in this version
  reviewReasons: string[];
  model: string;
  promptVersion: string;
  createdAt: string;
  // The fields it changes compared with the listing in the shop
  changes: ListingField[];
  fromImport: { id: string; fileName: string } | null;
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

export type BulkApproveResult = {
  approved: number;
  alreadyApproved: number;
  // Picked products that need review, left as they are because the merchant didn't say to approve them anyway
  needsReview: { id: string; title: string | null }[];
  skipped: { id: string; title: string | null; reason: string }[];
};

export type EditResult = { changed: string[]; warnings: string[]; product: ProductDetail };

// The shared helpers, so the review screen's files can import everything from here
export { errorMessage, sendJson } from "../api";
