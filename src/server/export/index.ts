import Papa from "papaparse";
import { z } from "zod";
import type { Db } from "@/server/db/client";
import { LOCALES } from "@/server/translations/fields";
import { enabledLocales } from "@/server/translations/languages";
import { CSV_COLUMNS, toCsvRows } from "./csv";
import { toJsonProduct } from "./json";
import { type ExportProduct, type ExportStatus, loadPage } from "./load";
import { SHOPIFY_COLUMNS, toShopifyRows } from "./shopify";

// The catalog as a file: CSV (one row per variant), JSON (the brief's product format with photos and
// translations) or Shopify's product CSV. Products are read and written a page at a time, so a 10,000-product
// export never sits in memory at once. Deleted products are never exported, and nothing here calls the AI

export const exportOptionsSchema = z.object({
  format: z.enum(["csv", "json", "shopify"]).default("csv"),
  // approved = what the storefront shows (the default); ready = passed every check, not approved yet; all
  status: z.enum(["approved", "ready", "all"]).default("approved"),
  // Titles, descriptions, tags, attributes and options as shoppers in that language see them
  language: z.enum(["en", ...LOCALES]).default("en"),
  // Shopify's "Vendor" when the supplier's sheet had no brand column
  vendor: z.string().trim().max(255).optional(),
});

export type ExportOptions = z.infer<typeof exportOptionsSchema>;

export const PAGE_SIZE = 200;

async function* allPages(db: Db, status: ExportStatus, first: ExportProduct[]) {
  let page = first;
  while (page.length) {
    yield page;
    if (page.length < PAGE_SIZE) return;
    page = await loadPage(db, { status, afterHandle: page.at(-1)!.product.handle, limit: PAGE_SIZE });
  }
}

// Excel reads a UTF-8 CSV correctly (umlauts, accents, "×") only with a byte order mark at the start.
// Both CSVs (ours and Shopify's) get one, JSON doesn't
const BOM = String.fromCharCode(0xfeff);

// CSV in pieces: the header first, then each page of rows. Cells that a spreadsheet would run as a formula
// ("=HYPERLINK(...)" from a supplier's sheet) get a ' in front, so opening the file is safe
async function* csvChunks<C extends string>(columns: readonly C[], pages: AsyncIterable<ExportProduct[]>, toRows: (item: ExportProduct) => Partial<Record<C, string>>[]) {
  const options = { escapeFormulae: true, newline: "\r\n" };
  // The header as a plain row, with no line break after it: each page starts with its own. (Papa ends a header
  // with no data under it with a line break, which left a blank line that some importers read as an empty product)
  yield BOM + Papa.unparse([[...columns]], options);
  for await (const page of pages) {
    const data = page.flatMap(toRows).map((row) => columns.map((c) => row[c] ?? ""));
    if (data.length) yield `\r\n${Papa.unparse(data, { ...options, header: false })}`;
  }
  yield "\r\n";
}

// JSON in pieces: an array, one product at a time
async function* jsonChunks(pages: AsyncIterable<ExportProduct[]>, toJson: (item: ExportProduct) => unknown) {
  let first = true;
  yield "[";
  for await (const page of pages) {
    for (const item of page) {
      yield `${first ? "\n  " : ",\n  "}${JSON.stringify(toJson(item), null, 2).replace(/\n/g, "\n  ")}`;
      first = false;
    }
  }
  yield first ? "]\n" : "\n]\n";
}

export type ExportFile = { contentType: string; fileName: string; chunks: AsyncIterable<string> };

// Reads the first page before answering, so a database problem is a clear error rather than a broken download
export async function exportCatalog(db: Db, options: ExportOptions & { origin: string; now?: Date }): Promise<ExportFile> {
  const { format, status, language, origin } = options;
  const first = await loadPage(db, { status, afterHandle: null, limit: PAGE_SIZE });
  const pages = allPages(db, status, first);
  const name = `catalog-${format === "shopify" ? "shopify-" : ""}${status}-${language}-${(options.now ?? new Date()).toISOString().slice(0, 10)}`;

  if (format === "json") {
    const shopLocales = await enabledLocales(db);
    return {
      contentType: "application/json; charset=utf-8",
      fileName: `${name}.json`,
      chunks: jsonChunks(pages, (item) => toJsonProduct(item, language, shopLocales, origin)),
    };
  }
  if (format === "shopify") {
    return {
      contentType: "text/csv; charset=utf-8",
      fileName: `${name}.csv`,
      chunks: csvChunks(SHOPIFY_COLUMNS, pages, (item) => toShopifyRows(item, language, origin, options.vendor)),
    };
  }
  return {
    contentType: "text/csv; charset=utf-8",
    fileName: `${name}.csv`,
    chunks: csvChunks(CSV_COLUMNS, pages, (item) => toCsvRows(item, language, origin)),
  };
}
