import { sql } from "drizzle-orm";
import Papa from "papaparse";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { importRows, imports, photos, products, translations, variants } from "@/server/db/schema";
import { readSheet } from "@/server/pipeline/read-sheet";
import type { CleanedRow } from "@/server/pipeline/types";
import { encodeValue, englishFields, fieldHashes } from "@/server/translations/fields";
import { setShopLanguages } from "@/test/fixtures";
import { testDatabaseUrl } from "@/test/global-setup";
import { CSV_COLUMNS } from "./csv";
import { exportCatalog, exportOptionsSchema, PAGE_SIZE } from "./index";
import { SHOPIFY_COLUMNS } from "./shopify";

const db = createDb(testDatabaseUrl());
const ORIGIN = "https://shop.example";

beforeEach(async () => {
  await db.execute(sql`truncate imports, products restart identity cascade`);
  await setShopLanguages(db, true);
});

afterAll(async () => {
  await db.$client.end();
});

async function download(options: Partial<Parameters<typeof exportCatalog>[1]> = {}) {
  const file = await exportCatalog(db, { ...exportOptionsSchema.parse({}), origin: ORIGIN, now: new Date("2026-10-22T12:00:00Z"), ...options });
  let text = "";
  for await (const chunk of file.chunks) text += chunk;
  return { ...file, text };
}

const BOM = String.fromCharCode(0xfeff);
const parseCsv = (text: string) => Papa.parse<Record<string, string>>(text.replace(BOM, ""), { header: true, skipEmptyLines: true });
// The first bytes of the file as the download sends them (the route encodes the text as UTF-8)
const firstBytes = (text: string, count: number) => [...new TextEncoder().encode(text).slice(0, count)];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

// A small catalog: an approved planter (3 sizes, 4 photos, a German translation with one field that failed a
// check), an approved bench with a formula in its title, a product that's only ready, and a deleted one
async function seedCatalog() {
  const [imp] = await db.insert(imports).values({ sheetFileName: "supplier.csv", status: "done" }).returning();
  const brandRow = (rowNumber: number) => ({
    importId: imp.id,
    rowNumber,
    raw: {},
    rowHash: `h${rowNumber}`,
    status: "done" as const,
    cleaned: { brand: rowNumber === 2 ? "Green Fingers Ltd" : null } as unknown as CleanedRow,
  });
  await db.insert(importRows).values([brandRow(2), brandRow(3), brandRow(20)]);

  const planterText = {
    title: "Hand-thrown Terracotta Planter",
    descriptionHtml: "<p>Hand-thrown terracotta planter with drainage hole.</p>",
    tags: ["terracotta", "planter"],
    attributes: { material: "terracotta" },
    category: "Home & Garden > Planters",
  };
  const [planter] = await db
    .insert(products)
    .values({
      ...planterText,
      productKey: "parent:tc-pl",
      handle: "hand-thrown-terracotta-planter",
      status: "approved",
      claims: [{ text: "frost-resistant", source: "supplier.csv, row 2, column Notes", quote: "frost-resistant (not frost-proof)" }],
      confidence: { title: 97, category: 81, "attributes.material": 90 },
      sourceRows: [2, 3, 20],
      lastImportId: imp.id,
    })
    .returning();
  const planterVariants = [
    { sku: "TC-PL-20", options: { size: "20 cm", color: "terracotta" }, priceCents: 2499, currency: "EUR", weightGrams: 1800, position: 0 },
    { sku: "TC-PL-30", options: { size: "30 cm", color: "terracotta" }, priceCents: null, currency: null, weightGrams: 3100, position: 1 },
    { sku: "TC-PL-40", options: { size: "40 cm", color: "terracotta" }, priceCents: 3990, currency: "EUR", weightGrams: 5200, position: 2 },
  ];
  await db.insert(variants).values(planterVariants.map((v) => ({ ...v, productId: planter.id })));
  const photo = (fileName: string, sku: string | null, position: number) => ({
    importId: imp.id,
    fileName,
    status: "matched" as const,
    storagePath: `photos/${fileName}.webp`,
    thumbnailPath: `photos/${fileName}-thumb.webp`,
    contentHash: fileName,
    width: 800,
    height: 800,
    processedAt: new Date(),
    productId: planter.id,
    sku,
    position,
  });
  const planterPhotos = await db
    .insert(photos)
    .values([photo("TC-PL-20.jpg", "TC-PL-20", 0), photo("TC-PL-30.jpg", "TC-PL-30", 1), photo("TC-PL-40.jpg", "TC-PL-40", 2), photo("detail.jpg", null, 3)])
    .returning({ id: photos.id, fileName: photos.fileName });

  // German, as the translation job leaves it: title and options translated, the description's translation
  // failed a check (so shoppers read it in English), tags and attributes not translated yet. No French yet
  const hashes = fieldHashes(englishFields(planterText, planterVariants));
  const german = (field: string, value: unknown, issue: string | null = null) => ({
    productId: planter.id,
    locale: "de",
    field,
    value: encodeValue(value),
    sourceHash: hashes[field],
    writtenBy: "ai" as const,
    issue,
  });
  await db.insert(translations).values([
    german("title", "Handgedrehter Terrakotta-Übertopf"),
    german("description_html", "<p>Frostfester Übertopf.</p>", "It claims frost-proof, which the English doesn't"),
    german("options", {
      color: { label: "Farbe", values: { terracotta: "Terrakotta" } },
      size: { label: "Größe", values: { "20 cm": "20 cm", "30 cm": "30 cm", "40 cm": "40 cm" } },
    }),
  ]);

  // A supplier's formula, which a spreadsheet would run when the file is opened
  const [bench] = await db
    .insert(products)
    .values({ productKey: "sku:gb-oak", handle: "oak-garden-bench", title: '=HYPERLINK("http://evil.example","Oak Bench")', status: "approved", sourceRows: [9] })
    .returning();
  await db.insert(variants).values({ productId: bench.id, sku: "GB-OAK", options: {}, priceCents: 129900, currency: "EUR", weightGrams: 32000 });

  const [tray] = await db.insert(products).values({ productKey: "sku:00123", handle: "seed-starter-tray", title: "Seed Starter Tray", status: "ready" }).returning();
  await db.insert(variants).values({ productId: tray.id, sku: "00123", priceCents: 699, currency: "EUR" });
  await db.insert(products).values({ productKey: "sku:vs", handle: "old-vase", title: "Old Vase", status: "approved", deletedAt: new Date() });

  const photoUrl = (fileName: string) => `${ORIGIN}/api/photos/${planterPhotos.find((p) => p.fileName === fileName)!.id}`;
  return { planter, photoUrl };
}

describe("export", () => {
  it("CSV: one row per variant of the approved products, the product's fields repeated, and it parses back", async () => {
    const { photoUrl } = await seedCatalog();
    const file = await download();
    expect(file).toMatchObject({ contentType: "text/csv; charset=utf-8", fileName: "catalog-approved-en-2026-10-22.csv" });
    // A byte order mark, so Excel reads umlauts and accents right
    expect(firstBytes(file.text, 3)).toEqual(UTF8_BOM);
    // The first product comes right after the header: a blank line would read as an empty product
    const lines = file.text.split("\r\n");
    expect(lines[0]).toBe(BOM + CSV_COLUMNS.join(","));
    expect(lines[1]).toMatch(/^hand-thrown-terracotta-planter,Hand-thrown Terracotta Planter,approved,/);
    expect(lines.slice(0, -1)).not.toContain("");
    expect(file.text.endsWith("\r\n")).toBe(true);

    const { data, meta, errors } = parseCsv(file.text);
    expect(errors).toEqual([]);
    expect(meta.fields).toEqual([...CSV_COLUMNS]);
    expect(data.map((r) => [r.handle, r.variant_sku, r.price, r.currency])).toEqual([
      ["hand-thrown-terracotta-planter", "TC-PL-20", "24.99", "EUR"],
      ["hand-thrown-terracotta-planter", "TC-PL-30", "", ""],
      ["hand-thrown-terracotta-planter", "TC-PL-40", "39.90", "EUR"],
      ["oak-garden-bench", "GB-OAK", "1299.00", "EUR"],
    ]);
    expect(data[0]).toMatchObject({
      title: "Hand-thrown Terracotta Planter",
      status: "approved",
      category: "Home & Garden > Planters",
      tags: "terracotta, planter",
      attributes: "Material: terracotta",
      variant_options: "Size: 20 cm; Colour: terracotta",
      weight_grams: "1800",
      image_urls: [photoUrl("TC-PL-20.jpg"), photoUrl("TC-PL-30.jpg"), photoUrl("TC-PL-40.jpg"), photoUrl("detail.jpg")].join(" | "),
      claims: "frost-resistant (supplier.csv, row 2, column Notes)",
      lowest_confidence: "81",
      source_rows: "2, 3, 20",
      fields_in_english: "",
    });
    // The formula is written as text, not run
    expect(data[3].title).toBe(`'=HYPERLINK("http://evil.example","Oak Bench")`);
  });

  it("CSV in German: what German shoppers read, and which fields they still read in English", async () => {
    await seedCatalog();
    const { data } = parseCsv((await download({ language: "de" })).text);
    expect(data[0]).toMatchObject({
      title: "Handgedrehter Terrakotta-Übertopf",
      category: "Haus & Garten > Pflanzgefäße",
      variant_options: "Größe: 20 cm; Farbe: Terrakotta",
      // The AI's German description failed a check, so the English is used
      description_html: "<p>Hand-thrown terracotta planter with drainage hole.</p>",
      fields_in_english: "description_html, tags, attributes",
    });
  });

  it("JSON: the brief's product format, with absolute photo links and the product in every shop language", async () => {
    const { photoUrl } = await seedCatalog();
    const file = await download({ format: "json" });
    expect(file).toMatchObject({ contentType: "application/json; charset=utf-8", fileName: "catalog-approved-en-2026-10-22.json" });
    // No byte order mark in JSON
    expect(file.text.startsWith("[\n  {")).toBe(true);
    const exported = JSON.parse(file.text);
    expect(exported).toHaveLength(2);

    const [planter] = exported;
    expect(Object.keys(planter)).toEqual([
      "title",
      "handle",
      "description_html",
      "category",
      "tags",
      "attributes",
      "variants",
      "claims",
      "confidence",
      "status",
      "review_reason",
      "source_rows",
      "photos",
      "translations",
    ]);
    expect(planter).toMatchObject({
      title: "Hand-thrown Terracotta Planter",
      handle: "hand-thrown-terracotta-planter",
      attributes: { material: "terracotta" },
      claims: [{ text: "frost-resistant", source: "supplier.csv, row 2, column Notes" }],
      confidence: { title: 97, category: 81, "attributes.material": 90 },
      status: "approved",
      review_reason: null,
      source_rows: [2, 3, 20],
    });
    expect(planter.variants[0]).toEqual({ sku: "TC-PL-20", options: { size: "20 cm", color: "terracotta" }, price_cents: 2499, currency: "EUR", weight_grams: 1800 });
    expect(planter.variants[1]).toMatchObject({ sku: "TC-PL-30", price_cents: null, currency: null });
    expect(planter.photos[0]).toEqual({ url: photoUrl("TC-PL-20.jpg"), thumbnail_url: `${photoUrl("TC-PL-20.jpg")}?size=thumb`, sku: "TC-PL-20", width: 800, height: 800 });

    expect(Object.keys(planter.translations)).toEqual(["de", "fr"]);
    expect(planter.translations.de).toMatchObject({
      title: "Handgedrehter Terrakotta-Übertopf",
      category: "Haus & Garten > Pflanzgefäße",
      options: { color: { label: "Farbe", values: { terracotta: "Terrakotta" } } },
      fields_in_english: ["description_html", "tags", "attributes"],
      out_of_date: [],
    });
    // Nothing in French yet: French shoppers read everything in English, and the export says so
    expect(planter.translations.fr).toMatchObject({ title: "Hand-thrown Terracotta Planter", fields_in_english: ["title", "description_html", "tags", "attributes", "options"] });
  });

  it("only lists the languages the shop shows", async () => {
    await seedCatalog();
    await setShopLanguages(db, false);
    const [planter] = JSON.parse((await download({ format: "json" })).text);
    expect(planter.translations).toEqual({});
  });

  it("Shopify: a product row, a row per variant, rows for extra photos, the way Shopify's own export writes them", async () => {
    const { photoUrl } = await seedCatalog();
    const file = await download({ format: "shopify", vendor: "My Shop" });
    expect(file.fileName).toBe("catalog-shopify-approved-en-2026-10-22.csv");
    // A byte order mark like our CSV (Excel shows "×", "ä" and "é" right), then the header and straight away the first row
    expect(firstBytes(file.text, 3)).toEqual(UTF8_BOM);
    const lines = file.text.split("\r\n");
    expect(lines[0]).toBe(BOM + SHOPIFY_COLUMNS.join(","));
    expect(lines[1]).toMatch(/^hand-thrown-terracotta-planter,Hand-thrown Terracotta Planter,/);
    expect(lines.slice(0, -1)).not.toContain("");

    const { data, meta, errors } = parseCsv(file.text);
    expect(errors).toEqual([]);
    expect(meta.fields).toEqual([...SHOPIFY_COLUMNS]);
    const planter = data.filter((r) => r.Handle === "hand-thrown-terracotta-planter");
    expect(planter).toHaveLength(4);
    expect(planter[0]).toMatchObject({
      Title: "Hand-thrown Terracotta Planter",
      "Body (HTML)": "<p>Hand-thrown terracotta planter with drainage hole.</p>",
      Vendor: "Green Fingers Ltd",
      "Product Category": "",
      Type: "Planters",
      Tags: "terracotta, planter",
      Published: "TRUE",
      "Option1 Name": "Colour",
      "Option1 Value": "terracotta",
      "Option2 Name": "Size",
      "Option2 Value": "20 cm",
      "Variant SKU": "TC-PL-20",
      "Variant Grams": "1800",
      "Variant Weight Unit": "kg",
      "Variant Inventory Policy": "deny",
      "Variant Fulfillment Service": "manual",
      "Variant Price": "24.99",
      "Variant Requires Shipping": "TRUE",
      "Variant Taxable": "TRUE",
      "Image Src": photoUrl("TC-PL-20.jpg"),
      "Image Position": "1",
      "Image Alt Text": "Hand-thrown Terracotta Planter",
      "Variant Image": photoUrl("TC-PL-20.jpg"),
      "Gift Card": "FALSE",
      "SEO Title": "Hand-thrown Terracotta Planter",
      Status: "active",
    });
    // Variant rows carry only the variant (and the next photo); options are named on the first row only
    expect(planter[1]).toMatchObject({ Title: "", "Option1 Name": "", "Option2 Value": "30 cm", "Variant SKU": "TC-PL-30", "Variant Price": "", "Image Position": "2" });
    // The fourth photo has no variant to sit next to: a row with the handle and the photo only
    expect(planter[3]).toMatchObject({ "Variant SKU": "", "Image Src": photoUrl("detail.jpg"), "Image Position": "4" });

    const bench = data.filter((r) => r.Handle === "oak-garden-bench");
    // No options: Shopify's "Title / Default Title". No brand in the sheet: the vendor given with the export
    expect(bench).toEqual([
      expect.objectContaining({ Vendor: "My Shop", "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant Price": "1299.00", "Variant Grams": "32000" }),
    ]);
  });

  it("Shopify in German, and a file our own importer reads back as a Shopify export", async () => {
    await seedCatalog();
    const text = (await download({ format: "shopify", language: "de", status: "all" })).text;
    const { data } = parseCsv(text);
    expect(data[0]).toMatchObject({ Title: "Handgedrehter Terrakotta-Übertopf", "Option1 Name": "Farbe", "Option1 Value": "Terrakotta", "Option2 Name": "Größe", Type: "Pflanzgefäße" });
    expect(data.find((r) => r.Handle === "seed-starter-tray")).toMatchObject({ Published: "FALSE", Status: "draft" });

    const sheet = readSheet(new TextEncoder().encode(text), "csv");
    expect(sheet.info.format).toBe("shopify");
    expect(sheet.rows).toHaveLength(data.length);
  });

  it("filters by status, and never exports a deleted product", async () => {
    await seedCatalog();
    const handles = async (status: "approved" | "ready" | "all") => [...new Set(parseCsv((await download({ status })).text).data.map((r) => r.handle))];
    expect(await handles("approved")).toEqual(["hand-thrown-terracotta-planter", "oak-garden-bench"]);
    expect(await handles("ready")).toEqual(["seed-starter-tray"]);
    expect(await handles("all")).toEqual(["hand-thrown-terracotta-planter", "oak-garden-bench", "seed-starter-tray"]);
  });

  it("goes through a big catalog page by page, without skipping or repeating a product", async () => {
    const count = PAGE_SIZE * 2 + 50;
    const rows = Array.from({ length: count }, (_, i) => ({ productKey: `k${i}`, handle: `product-${String(i).padStart(4, "0")}`, title: `Product ${i}`, status: "approved" as const }));
    const created = await db.insert(products).values(rows).returning({ id: products.id });
    await db.insert(variants).values(created.map((p, i) => ({ productId: p.id, sku: `SKU-${i}`, priceCents: 100 + i, currency: "EUR" })));

    const file = await exportCatalog(db, { ...exportOptionsSchema.parse({ format: "json" }), origin: ORIGIN });
    let chunks = 0;
    let text = "";
    for await (const chunk of file.chunks) {
      chunks++;
      text += chunk;
    }
    const exported: { handle: string }[] = JSON.parse(text);
    expect(exported).toHaveLength(count);
    expect(new Set(exported.map((p) => p.handle)).size).toBe(count);
    // Written a product at a time, not as one big string
    expect(chunks).toBeGreaterThan(count);
  });

  it("checks the options: csv, approved and English unless asked otherwise", () => {
    expect(exportOptionsSchema.parse({})).toEqual({ format: "csv", status: "approved", language: "en" });
    expect(exportOptionsSchema.safeParse({ format: "xml" }).success).toBe(false);
    expect(exportOptionsSchema.safeParse({ language: "es" }).success).toBe(false);
  });

  it("writes an empty catalog as a header or an empty list", async () => {
    expect((await download()).text).toBe(`${BOM}${CSV_COLUMNS.join(",")}\r\n`);
    expect((await download({ format: "shopify" })).text).toBe(`${BOM}${SHOPIFY_COLUMNS.join(",")}\r\n`);
    expect((await download({ format: "json" })).text).toBe("[]\n");
  });
});
