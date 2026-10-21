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

export const photoStatus = pgEnum("photo_status", ["matched", "unmatched", "rejected"]);

export const translationAuthor = pgEnum("translation_author", ["ai", "merchant"]);

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
  // e.g. "row 14, column Notes"
  source: string;
  // The exact source text the claim came from, checked in code
  quote: string;
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
    reviewReason: text(),
    sourceRows: integer().array().notNull().default(sql`'{}'::int[]`),
    lastImportId: uuid().references(() => imports.id, { onDelete: "set null" }),
    // Hash of the cleaned source rows. Same hash on re-upload = no AI call
    sourceHash: text(),
    // Fields the merchant changed by hand. The AI never overwrites these
    merchantEditedFields: text().array().notNull().default(sql`'{}'::text[]`),
    model: text(),
    promptVersion: text(),
    approvedAt: timestamp({ withTimezone: true }),
    // Soft delete, so a re-upload doesn't silently bring it back
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.status)],
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
    ...timestamps,
  },
  (t) => [
    index().on(t.productId),
    check("variants_price_not_negative", sql`${t.priceCents} >= 0`),
    check("variants_price_has_currency", sql`(${t.priceCents} is null) = (${t.currency} is null)`),
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
    fileName: text().notNull(),
    // Where the resized copy is stored. null if the file was rejected
    storagePath: text(),
    contentHash: text(),
    width: integer(),
    height: integer(),
    productId: uuid().references(() => products.id, { onDelete: "set null" }),
    position: integer().notNull().default(0),
    status: photoStatus().notNull().default("unmatched"),
    reason: text(),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.importId, t.fileName), index().on(t.productId)],
);

export const translations = pgTable(
  "translations",
  {
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    // "de" | "fr"
    locale: text().notNull(),
    // "title", "description_html", ...
    field: text().notNull(),
    value: text().notNull(),
    // Hash of the English text this was translated from. If the English changes, the hash no longer matches
    sourceHash: text().notNull(),
    writtenBy: translationAuthor().notNull().default("ai"),
    // The merchant's translation, but the English changed since
    outOfDate: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.productId, t.locale, t.field] })],
);

export const aiCalls = pgTable(
  "ai_calls",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    importId: uuid().references(() => imports.id, { onDelete: "set null" }),
    // "build" | "translate"
    purpose: text().notNull(),
    // "gemini" | "groq" | "mock"
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
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
