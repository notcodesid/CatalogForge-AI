import { describe, expect, it } from "vitest";
import { CATEGORIES } from "@/server/ai/taxonomy";
import { translateCategory, translatedCategoryParts } from "./categories";
import { englishFields, fieldHashes } from "./fields";
import { localizeProduct, seoFields, type TranslationRow } from "./localize";

const product = {
  title: "Stoneware Mug",
  descriptionHtml: "<p>Stoneware mug, 350 ml.</p>",
  tags: ["mug"],
  attributes: { material: "stoneware" },
  category: "Home & Garden > Kitchen & Dining > Mugs & Cups",
};
const variants = [{ options: { size: "350 ml", color: "grey" } }];
const hashes = fieldHashes(englishFields(product, variants));
const row = (field: string, value: unknown, extra: Partial<TranslationRow> = {}): TranslationRow => ({
  field,
  value: typeof value === "string" ? value : JSON.stringify(value),
  sourceHash: hashes[field],
  writtenBy: "ai",
  issue: null,
  ...extra,
});

describe("localizeProduct", () => {
  it("shows the AI's translation when it's made from the current English and passed every check", () => {
    const shown = localizeProduct(product, variants, [row("title", "Steingutbecher"), row("options", { color: { label: "Farbe", values: { grey: "Grau" } }, size: { label: "Größe", values: { "350 ml": "350 ml" } } })], "de");
    expect(shown).toMatchObject({ title: "Steingutbecher", category: "Haus & Garten > Küche & Esszimmer > Tassen & Becher" });
    expect(shown.options).toEqual([
      { name: "color", label: "Farbe", values: { grey: "Grau" } },
      { name: "size", label: "Größe", values: { "350 ml": "350 ml" } },
    ]);
    expect(shown.sources).toMatchObject({ title: "ai", options: "ai", description_html: "english" });
  });

  it("falls back to English for a missing, outdated or flagged translation, never waiting for the AI", () => {
    const shown = localizeProduct(
      product,
      variants,
      [row("title", "Alter Titel", { sourceHash: "old" }), row("description_html", "<p>Spülmaschinenfest.</p>", { issue: "It claims dishwasher-safe, which the English doesn't" })],
      "de",
    );
    expect(shown.title).toBe("Stoneware Mug");
    expect(shown.descriptionHtml).toBe("<p>Stoneware mug, 350 ml.</p>");
    expect(shown.attributes).toEqual([{ key: "material", label: "Material", value: "stoneware" }]);
    expect(shown.sources).toMatchObject({ title: "english", description_html: "english", attributes: "english" });
  });

  it("always shows the merchant's own translation, and says when its English changed", () => {
    const shown = localizeProduct(product, variants, [row("title", "Becher aus Steinzeug", { writtenBy: "merchant", sourceHash: "old" })], "de");
    expect(shown.title).toBe("Becher aus Steinzeug");
    expect(shown.sources.title).toBe("merchant");
    expect(shown.outOfDate).toEqual(["title"]);
  });

  it("writes decimals in sizes the way German and French do, whatever the AI wrote", () => {
    // Seen in a real run: "30,5 cm" on one product and "10.2 cm" on the next
    const bowl = [{ options: { size: "10.2 cm" } }, { options: { size: "Ø 15.5 cm" } }, { options: { size: "Model 2.5" } }];
    const sizes = (locale: "de" | "fr" | "en") => localizeProduct(product, bowl, [], locale).options[0].values;
    expect(sizes("de")).toEqual({ "10.2 cm": "10,2 cm", "Ø 15.5 cm": "Ø 15,5 cm", "Model 2.5": "Model 2.5" });
    expect(sizes("fr")["10.2 cm"]).toBe("10,2 cm");
    expect(sizes("en")["10.2 cm"]).toBe("10.2 cm");
  });

  it("shows English to everyone else", () => {
    const shown = localizeProduct(product, variants, [row("title", "Steingutbecher")], "en");
    expect(shown.title).toBe("Stoneware Mug");
    expect(shown.options[0]).toMatchObject({ label: "Colour" });
  });
});

describe("categories", () => {
  it("has a German and French name for every part of every category", () => {
    const parts = new Set(CATEGORIES.flatMap((c) => c.split(" > ")));
    expect([...parts].filter((p) => !translatedCategoryParts().includes(p))).toEqual([]);
    expect(translateCategory("Home & Garden > Planters", "fr")).toBe("Maison & Jardin > Pots & Jardinières");
  });
});

describe("seoFields", () => {
  it("cuts the meta title and description at a word, from what the shopper reads", () => {
    const seo = seoFields("Handgedrehter Terrakotta-Übertopf mit Abflussloch für drinnen und draußen", `<p>${"Ein schöner Topf. ".repeat(20)}</p>`);
    expect(seo.metaTitle.length).toBeLessThanOrEqual(60);
    expect(seo.metaTitle.endsWith("…")).toBe(true);
    expect(seo.metaDescription.length).toBeLessThanOrEqual(155);
    expect(seo.metaDescription.startsWith("Ein schöner Topf.")).toBe(true);
  });
});
