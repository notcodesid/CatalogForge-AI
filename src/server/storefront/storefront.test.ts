import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { imports, photos, products, translations, variants } from "@/server/db/schema";
import { englishFields, fieldHashes } from "@/server/translations/fields";
import { testDatabaseUrl } from "@/test/global-setup";
import { formatPrice, intlLocale, languageFor, normalizeCountry, pickCountry, type ShopCountry } from "./country";
import { loadShopCategories, loadShopCountries, loadShopPage, loadShopProduct, PAGE_SIZE } from "./data";
import { revalidateStorefront } from "./revalidate";

const db = createDb(testDatabaseUrl());

beforeEach(async () => {
  await db.execute(sql`truncate imports, products restart identity cascade`);
});

afterAll(async () => {
  await db.$client.end();
});

// Plain spaces: Intl puts no-break spaces between the number and the currency in German and French
const plain = (text: string) => text.replace(/\s/g, " ");

describe("choosing the shopper's country and language", () => {
  const countries: ShopCountry[] = [
    { country: "DE", name: "Germany", language: "de", enabled: true },
    { country: "AT", name: "Austria", language: "de", enabled: true },
    { country: "FR", name: "France", language: "fr", enabled: true },
    { country: "BE", name: "Belgium", language: "fr", enabled: false },
  ];

  it("takes the switcher's link first, then its cookie, then the country the platform detected", () => {
    const headers = new Headers({ "x-vercel-ip-country": "fr", "cf-ipcountry": "AT" });
    expect(pickCountry({ query: "de", cookie: "FR", headers })).toEqual({ country: "DE", fromQuery: true });
    expect(pickCountry({ query: undefined, cookie: "at", headers })).toEqual({ country: "AT", fromQuery: false });
    expect(pickCountry({ headers })).toEqual({ country: "FR", fromQuery: false });
    expect(pickCountry({ headers: new Headers({ "cf-ipcountry": "AT" }) })).toEqual({ country: "AT", fromQuery: false });
    // Junk in a link (or Cloudflare's "T1" for Tor) is ignored
    expect(pickCountry({ query: "<script>", cookie: "T1", headers: new Headers() })).toEqual({ country: null, fromQuery: false });
    expect(normalizeCountry(["be", "fr"])).toBe("BE");
  });

  it("shows a country's language only while it's switched on, English to everyone else", () => {
    expect(languageFor("DE", countries)).toBe("de");
    expect(languageFor("AT", countries)).toBe("de");
    expect(languageFor("FR", countries)).toBe("fr");
    expect(languageFor("BE", countries)).toBe("en");
    expect(languageFor("ES", countries)).toBe("en");
    expect(languageFor(null, countries)).toBe("en");
  });

  it("writes prices the way the shopper's country does", () => {
    expect(intlLocale("de", "AT")).toBe("de-AT");
    expect(intlLocale("en", null)).toBe("en-GB");
    expect(intlLocale("en", "XX")).toBe("en-GB");
    expect(plain(formatPrice(2499, "EUR", intlLocale("de", "DE")))).toBe("24,99 €");
    expect(plain(formatPrice(2499, "EUR", intlLocale("fr", "FR")))).toBe("24,99 €");
    expect(formatPrice(800, "GBP", intlLocale("en", null))).toBe("£8.00");
    expect(plain(formatPrice(129900, "EUR", "de-DE"))).toBe("1.299,00 €");
  });

  it("reads the countries the merchant set up", async () => {
    const all = await loadShopCountries(db);
    expect(all.filter((c) => c.enabled).map((c) => c.country).sort()).toEqual(["AT", "DE", "FR"]);
  });
});

describe("what the storefront shows", () => {
  const importId = randomUUID();
  type Seed = { title: string; status?: "approved" | "ready" | "needs_review"; deleted?: boolean; category?: string; variants?: { sku: string; options: Record<string, string>; price: number | null; currency?: string }[] };

  async function seed(product: Seed) {
    const handle = product.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const [row] = await db
      .insert(products)
      .values({
        productKey: `key:${handle}`,
        handle,
        title: product.title,
        descriptionHtml: `<p>${product.title}, made of terracotta.</p>`,
        category: product.category ?? "Home & Garden > Planters",
        tags: ["garden"],
        attributes: { material: "terracotta" },
        status: product.status ?? "approved",
        deletedAt: product.deleted ? new Date() : null,
      })
      .returning();
    const own = product.variants ?? [{ sku: `${handle}-1`, options: {}, price: 1000 }];
    await db.insert(variants).values(
      own.map((v, position) => ({
        productId: row.id,
        sku: v.sku,
        options: v.options,
        priceCents: v.price,
        currency: v.price === null ? null : (v.currency ?? "EUR"),
        position,
      })),
    );
    const hashes = fieldHashes(englishFields(row, own));
    return { ...row, hashes };
  }

  async function translate(product: { id: string; hashes: Record<string, string> }, locale: string, field: string, value: unknown, extra: { stale?: boolean; issue?: string } = {}) {
    await db.insert(translations).values({
      productId: product.id,
      locale,
      field,
      value: typeof value === "string" ? value : JSON.stringify(value),
      sourceHash: extra.stale ? "old" : product.hashes[field],
      issue: extra.issue ?? null,
    });
  }

  async function seedShop() {
    await db.insert(imports).values({ id: importId, sheetFileName: "sheet.csv", status: "done" });
    const planter = await seed({
      title: "Terracotta Planter",
      variants: [
        { sku: "TC-40", options: { size: "40 cm", color: "terracotta" }, price: null },
        { sku: "TC-20", options: { size: "20 cm", color: "terracotta" }, price: 2499 },
        { sku: "TC-30", options: { size: "30 cm", color: "terracotta" }, price: 3499 },
      ],
    });
    const bench = await seed({ title: "Oak Bench", category: "Home & Garden > Garden Furniture", variants: [{ sku: "OB-1", options: {}, price: 12900, currency: "GBP" }] });
    await seed({ title: "Stoneware Mug", deleted: true });
    await seed({ title: "Glazed Vase", status: "ready" });
    await seed({ title: "Seed Tray", status: "needs_review" });

    await translate(planter, "de", "title", "Terrakotta-Übertopf");
    await translate(planter, "de", "description_html", "<p>Übertopf aus Terrakotta.</p>");
    await translate(planter, "de", "options", {
      color: { label: "Farbe", values: { terracotta: "Terrakotta" } },
      size: { label: "Größe", values: { "20 cm": "20 cm", "30 cm": "30 cm", "40 cm": "40 cm" } },
    });
    await translate(planter, "fr", "title", "Cache-pot ingélif", { issue: "It claims frost-proof, which the English doesn't" });
    await translate(bench, "de", "title", "Alte Eichenbank", { stale: true });

    // Two photos of the planter, the second one first in the matching order
    await db.insert(photos).values([
      { importId, fileName: "TC-20.jpg", productId: planter.id, status: "matched", position: 1, storagePath: "photos/a.webp", thumbnailPath: "photos/a-thumb.webp", contentHash: "a", width: 800, height: 800 },
      { importId, fileName: "TC-30.jpg", productId: planter.id, status: "matched", position: 0, storagePath: "photos/b.webp", thumbnailPath: "photos/b-thumb.webp", contentHash: "b", width: 800, height: 600 },
      // Not processed yet, and rejected: never shown
      { importId, fileName: "TC-40.jpg", productId: planter.id, status: "matched", position: 2, contentHash: null },
      { importId, fileName: "bad.jpg", productId: planter.id, status: "rejected", position: 3, storagePath: "photos/c.webp", contentHash: "c" },
    ]);
    return { planter, bench };
  }

  it("lists only approved products that aren't deleted, in the shopper's language when the translation can be trusted", async () => {
    const { planter } = await seedShop();

    const english = await loadShopPage(db, "en");
    expect(english).toMatchObject({ total: 2, page: 1, pageCount: 1 });
    expect(english.products.map((p) => p.title)).toEqual(["Oak Bench", "Terracotta Planter"]);

    const german = await loadShopPage(db, "de");
    // The bench's German title was made from older English: English instead
    expect(german.products.map((p) => [p.title, p.category])).toEqual([
      ["Oak Bench", "Haus & Garten > Gartenmöbel"],
      ["Terrakotta-Übertopf", "Haus & Garten > Pflanzgefäße"],
    ]);
    // The French title failed a check: English instead
    expect((await loadShopPage(db, "fr")).products[1].title).toBe("Terracotta Planter");

    const card = german.products[1];
    expect(card.price).toEqual({ cents: 2499, currency: "EUR", varies: true });
    expect(german.products[0].price).toEqual({ cents: 12900, currency: "GBP", varies: false });
    expect(card.photo?.id).toBeDefined();
    const [firstPhoto] = await db.select().from(photos).where(sql`${photos.fileName} = 'TC-30.jpg'`);
    expect(card.photo).toEqual({ id: firstPhoto.id, width: 800, height: 600 });
    expect(planter.handle).toBe("terracotta-planter");
  });

  it("filters by category, including the categories below it, and pages through big catalogs", async () => {
    await seedShop();
    expect((await loadShopPage(db, "en", { category: "Home & Garden > Planters" })).products.map((p) => p.title)).toEqual(["Terracotta Planter"]);
    expect((await loadShopPage(db, "en", { category: "Home & Garden" })).total).toBe(2);
    expect(await loadShopCategories(db, "de")).toEqual([
      { value: "Home & Garden > Garden Furniture", label: "Haus & Garten > Gartenmöbel", products: 1 },
      { value: "Home & Garden > Planters", label: "Haus & Garten > Pflanzgefäße", products: 1 },
    ]);

    for (let i = 0; i < PAGE_SIZE + 5; i++) await seed({ title: `Pot ${String(i).padStart(2, "0")}` });
    const second = await loadShopPage(db, "en", { page: 2 });
    expect(second).toMatchObject({ total: PAGE_SIZE + 7, page: 2, pageCount: 2 });
    expect(second.products).toHaveLength(7);
    // A page past the end shows the last page
    expect((await loadShopPage(db, "en", { page: 99 })).page).toBe(2);
  });

  it("shows a product page with translated options, photos in order and the lowest price", async () => {
    await seedShop();
    const german = await loadShopProduct(db, "terracotta-planter", "de");
    expect(german).toMatchObject({
      title: "Terrakotta-Übertopf",
      descriptionHtml: "<p>Übertopf aus Terrakotta.</p>",
      category: "Haus & Garten > Pflanzgefäße",
      categoryPath: [
        { value: "Home & Garden", label: "Haus & Garten" },
        { value: "Home & Garden > Planters", label: "Pflanzgefäße" },
      ],
      price: { cents: 2499, currency: "EUR", varies: true },
      seo: { metaTitle: "Terrakotta-Übertopf", metaDescription: "Übertopf aus Terrakotta." },
    });
    // Values in the order the variants list them
    expect(german!.options).toEqual([
      { name: "color", label: "Farbe", values: [{ value: "terracotta", label: "Terrakotta" }] },
      { name: "size", label: "Größe", values: ["40 cm", "20 cm", "30 cm"].map((v) => ({ value: v, label: v })) },
    ]);
    expect(german!.photos.map((p) => p.height)).toEqual([600, 800]);
    expect(german!.variants.map((v) => [v.sku, v.priceCents])).toEqual([
      ["TC-40", null],
      ["TC-20", 2499],
      ["TC-30", 3499],
    ]);

    const english = await loadShopProduct(db, "terracotta-planter", "en");
    expect(english!.options[0]).toMatchObject({ label: "Colour" });
    expect(english!.attributes).toEqual([{ key: "material", label: "Material", value: "terracotta" }]);
  });

  it("finds nothing for a product that's unknown, not approved yet, or deleted", async () => {
    await seedShop();
    expect(await loadShopProduct(db, "no-such-product", "en")).toBeNull();
    expect(await loadShopProduct(db, "glazed-vase", "en")).toBeNull();
    expect(await loadShopProduct(db, "seed-tray", "en")).toBeNull();
    expect(await loadShopProduct(db, "stoneware-mug", "en")).toBeNull();
  });

  it("can be asked to refresh the storefront from outside a Next.js request without failing", () => {
    expect(() => revalidateStorefront()).not.toThrow();
  });
});
