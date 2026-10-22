import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { OptionNames } from "../ai/option-names";
import type { ProductInput } from "../ai/prompt";
import type { CleanedRow, ParseInfo } from "../pipeline/types";

// Column names are camelCase here and snake_case in Postgres (casing: "snake_case" in the client and drizzle.config.ts)

export const importStatus = pgEnum("import_status", [
  "waiting_for_files",
  "queued",
  "running",
  "paused", // AI rate limit or provider down, resumes on its own
  "done",
  "failed",
]);

export const importStage = pgEnum("import_stage", ["parse", "clean", "group", "photos", "build", "translate"]);

// Every row ends as done, needs_review or failed
export const rowStatus = pgEnum("row_status", ["pending", "processing", "done", "needs_review", "failed"]);

// ready = AI result looks fine, waiting for the merchant to approve. Only approved products show in the storefront
export const productStatus = pgEnum("product_status", ["needs_review", "ready", "approved"]);

// pending = uploaded, not matched to a product yet. rejected = not a usable photo (broken, too big, not an image)
export const photoStatus = pgEnum("photo_status", ["pending", "matched", "unmatched", "rejected"]);

export const translationAuthor = pgEnum("translation_author", ["ai", "merchant"]);

// Per product and shop language. pending = its English changed (or the language was switched on) and the
// translation still has to be written; failed = the AI couldn't, with the error
export const translationStatus = pgEnum("translation_status", ["pending", "done", "failed"]);

export const aiCallStatus = pgEnum("ai_call_status", ["ok", "invalid_output", "rate_limited", "timeout", "error"]);

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const imports = pgTable(
  "imports",
  {
    id: uuid().primaryKey().defaultRandom(),
    status: importStatus().notNull().default("waiting_for_files"),
    stage: importStage(),
    sheetFileName: text().notNull(),
    sheetPath: text(),
    // sha256 of the sheet, to spot the same file uploaded twice
    sheetHash: text(),
    // Used when a price has no currency anywhere in the sheet
    defaultCurrency: char({ length: 3 }).notNull().default("EUR"),
    // What we learned reading the file: header row, column mapping, encoding, blank rows
    parseInfo: jsonb().$type<ParseInfo>(),
    // Set once the sheet is parsed
    totalRows: integer(),
    // Why the whole import failed (e.g. unreadable file)
    error: text(),
    // Goes up by one every time a worker starts on this import. A worker only saves its work while it
    // still holds the newest number, so an old attempt that wakes up late can't overwrite a newer one
    attempt: integer().notNull().default(0),
    // How many times the watchdog restarted this import after its job went missing
    recoveries: integer().notNull().default(0),
    // Set once the AI batches for this import have been queued
    buildPlannedAt: timestamp({ withTimezone: true }),
    // Photos the sheet names (e.g. "MG-01.jpg" in its image column) that weren't uploaded, with the rows naming them
    missingPhotos: jsonb().$type<{ file: string; rows: number[] }[]>(),
    // Photo links in the sheet that weren't downloaded because the import already had the most photos allowed
    photoLinksOverLimit: integer().notNull().default(0),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // The same file can't be imported twice at the same time. Enforced by Postgres, so even two uploads
    // arriving in the same millisecond end up as one import
    uniqueIndex("imports_one_active_per_file")
      .on(t.sheetHash)
      .where(sql`${t.status} in ('queued', 'running', 'paused')`),
  ],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    importId: uuid()
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    // The row number the merchant sees in their sheet
    rowNumber: integer().notNull(),
    raw: jsonb().$type<Record<string, string>>().notNull(),
    cleaned: jsonb().$type<CleanedRow>(),
    // Hash of the raw values, so unchanged rows are skipped on re-upload
    rowHash: text().notNull(),
    productKey: text(),
    status: rowStatus().notNull().default("pending"),
    // Why it needs review or failed
    reason: text(),
    ...timestamps,
  },
  (t) => [
    // Re-running the parser after a restart can't store the same row twice
    uniqueIndex().on(t.importId, t.rowNumber),
    index().on(t.importId, t.status),
    index().on(t.productKey),
  ],
);

export type Claim = {
  text: string;
  // e.g. "supplier.csv, row 14, column Notes"
  source: string;
  // The exact source text the claim came from, checked in code
  quote: string;
};

// A new listing the AI wrote for a product that's already approved (a newer sheet, or newer instructions). It waits
// here for the merchant: the approved listing stays in the shop until they use this one or keep theirs
export type PendingListing = {
  title: string;
  descriptionHtml: string;
  category: string | null;
  tags: string[];
  attributes: Record<string, string>;
  claims: Claim[];
  confidence: Record<string, number>;
  optionNames: OptionNames;
  // What the AI checks found in this version (like contentReviewReasons), shown next to it
  reviewReasons: string[];
  model: string;
  promptVersion: string;
  // The upload that made it, and when
  importId: string;
  createdAt: string;
};

export const products = pgTable(
  "products",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Stable key built from the sheet (parent SKU or cleaned name). Re-uploads update the same product
    productKey: text().notNull().unique(),
    handle: text().notNull().unique(),
    status: productStatus().notNull().default("needs_review"),
    title: text().notNull(),
    descriptionHtml: text().notNull().default(""),
    category: text(),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    attributes: jsonb().$type<Record<string, string>>().notNull().default({}),
    claims: jsonb().$type<Claim[]>().notNull().default([]),
    // Field name -> 0..100
    confidence: jsonb().$type<Record<string, number>>().notNull().default({}),
    // What the supplier's colour or size column really holds, when the AI says it's something else: { color: "scent" }.
    // Kept so a later price list (no AI call) still saves the variants under that name (see ai/option-names.ts)
    optionNames: jsonb().$type<OptionNames>().notNull().default({}),
    reviewReason: text(),
    sourceRows: integer().array().notNull().default(sql`'{}'::int[]`),
    lastImportId: uuid().references(() => imports.id, { onDelete: "set null" }),
    // Hash of the cleaned source rows. Same hash on re-upload = no AI call
    sourceHash: text(),
    // The supplier text the AI last wrote from, as it saw it: the listing's, or a newer version's that's waiting or
    // that the merchant turned down (see pendingListing). A later file with nothing new to say about the product
    // (e.g. a price list) is compared with this, and only updates prices and variants
    sourceInput: jsonb().$type<ProductInput>(),
    // Problems with the listing itself, found by the AI checks. The rows' own problems (no price...) are added
    // on top. Kept when a later file only updates prices and variants
    contentReviewReasons: text().array().notNull().default(sql`'{}'::text[]`),
    // Fields the merchant changed by hand. The AI never overwrites these
    merchantEditedFields: text().array().notNull().default(sql`'{}'::text[]`),
    // Fingerprint of each English field shoppers read (title, description_html, tags, attributes, options).
    // A translation made from different English is out of date (see translations/fields.ts)
    englishHashes: jsonb().$type<Record<string, string>>().notNull().default({}),
    model: text(),
    // The AI instructions the product was last written with (its listing, or the waiting new version). Older than
    // the current ones = the AI writes it again on the next upload
    promptVersion: text(),
    // The AI's new listing for an approved product, waiting for the merchant (null: nothing waiting)
    pendingListing: jsonb().$type<PendingListing>(),
    approvedAt: timestamp({ withTimezone: true }),
    // Soft delete, so a re-upload doesn't silently bring it back
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.status), index().on(t.lastImportId)],
);

export const variants = pgTable(
  "variants",
  {
    id: uuid().primaryKey().defaultRandom(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sku: text().notNull().unique(),
    // e.g. { size: "20 cm", color: "terracotta" }
    options: jsonb().$type<Record<string, string>>().notNull().default({}),
    // Integer cents, never a float. null = price missing, product goes to review
    priceCents: integer(),
    currency: char({ length: 3 }),
    weightGrams: integer(),
    position: integer().notNull().default(0),
    // The merchant typed this price in Edit. A re-upload of the sheet never changes it (theirs wins, like text they edit)
    priceSetByHand: boolean().notNull().default(false),
    // The price the supplier's sheet last gave this SKU (null: none, or two different ones). The same as the price,
    // unless the merchant set theirs by hand: then a sheet with a new price is pointed out to them once
    sheetPriceCents: integer(),
    sheetCurrency: char({ length: 3 }),
    ...timestamps,
  },
  (t) => [
    index().on(t.productId),
    check("variants_price_not_negative", sql`${t.priceCents} >= 0`),
    check("variants_price_has_currency", sql`(${t.priceCents} is null) = (${t.currency} is null)`),
    check("variants_sheet_price_has_currency", sql`(${t.sheetPriceCents} is null) = (${t.sheetCurrency} is null)`),
    check("variants_weight_not_negative", sql`${t.weightGrams} >= 0`),
  ],
);

export const photos = pgTable(
  "photos",
  {
    id: uuid().primaryKey().defaultRandom(),
    importId: uuid()
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    // As uploaded, with its folder inside a ZIP ("planters/TC-PL-20.jpg"). Sending the same file again is a no-op
    fileName: text().notNull(),
    // The upload as it arrived. Deleted once the photo is processed
    originalPath: text(),
    // Set when the photo comes from a link in the sheet (e.g. a Shopify export's image column) instead of an
    // upload: it's downloaded when processed. fileName is then the link itself
    sourceUrl: text(),
    // The processed copy (at most 1600 px, WebP, no location data) and its thumbnail. Named after the content,
    // so the same picture uploaded twice is stored once. null until processed, and for rejected files
    storagePath: text(),
    thumbnailPath: text(),
    contentHash: text(),
    width: integer(),
    height: integer(),
    processedAt: timestamp({ withTimezone: true }),
    // What it was matched to: the product's key in this import and the variant's SKU. productId and variantId
    // are filled in once the product is saved (or right away for a product already in the catalog)
    productKey: text(),
    sku: text(),
    productId: uuid().references(() => products.id, { onDelete: "set null" }),
    variantId: uuid().references(() => variants.id, { onDelete: "set null" }),
    // The sheet row that names this photo or has its SKU
    rowNumber: integer(),
    position: integer().notNull().default(0),
    status: photoStatus().notNull().default("unmatched"),
    // How it was matched, or why it's unmatched or rejected
    reason: text(),
    // The merchant put this photo on a product (or took it off) by hand. Automatic matching never changes it again
    assignedByHand: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.importId, t.fileName), index().on(t.productId), index().on(t.importId, t.status)],
);

export const translations = pgTable(
  "translations",
  {
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    // "de" | "fr"
    locale: text().notNull(),
    // "title", "description_html", "tags", "attributes" or "options"
    field: text().notNull(),
    // Text, or JSON for tags, attributes and options
    value: text().notNull(),
    // Fingerprint of the English this was translated from. When the English changes, it no longer matches
    // products.english_hashes: an AI translation is redone, a merchant's own one is kept and shown as out of date
    sourceHash: text().notNull(),
    writtenBy: translationAuthor().notNull().default("ai"),
    // Why the AI's translation isn't used (a number changed, a claim got stronger...). Shoppers see the English
    // instead, and the merchant can write the translation by hand
    issue: text(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.productId, t.locale, t.field] })],
);

// Whether each product's translation into each shop language is up to date. Translation work is queued from here:
// queuedAt is set when a translation job takes the row, so the same product is never queued twice
export const translationState = pgTable(
  "translation_state",
  {
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    locale: text().notNull(),
    status: translationStatus().notNull().default("pending"),
    error: text(),
    queuedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.productId, t.locale] }), index().on(t.status)],
);

// Which language each country's shoppers see. A country that's switched off (or not listed) sees English
export const countryLanguages = pgTable("country_languages", {
  // ISO code, e.g. "DE"
  country: char({ length: 2 }).primaryKey(),
  // "de" | "fr"
  language: text().notNull(),
  enabled: boolean().notNull().default(false),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const aiCalls = pgTable(
  "ai_calls",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    importId: uuid().references(() => imports.id, { onDelete: "set null" }),
    // "build" | "translate"
    purpose: text().notNull(),
    // "anthropic" | "deepseek" | "mock"
    provider: text().notNull(),
    model: text().notNull(),
    status: aiCallStatus().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    // What the call would cost at paid prices, in millionths of a dollar (integer, no floats)
    costMicroUsd: bigint({ mode: "number" }).notNull().default(0),
    latencyMs: integer().notNull(),
    productCount: integer().notNull().default(0),
    fromCache: boolean().notNull().default(false),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.importId), index().on(t.createdAt)],
);

// Saved AI answers, so a retry after a crash doesn't pay for the same call twice
export const aiCache = pgTable("ai_cache", {
  // sha256 of model + prompt version + input
  key: text().primaryKey(),
  model: text().notNull(),
  response: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// One row per AI provider. When rate limited, every worker waits until pausedUntil
export const aiStatus = pgTable("ai_status", {
  provider: text().primaryKey(),
  pausedUntil: timestamp({ withTimezone: true }),
  reason: text(),
  // Calls are spaced out to stay under the provider's requests-per-minute limit. Each call takes the next
  // free time slot from here, so all workers together keep to the limit
  nextCallAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
