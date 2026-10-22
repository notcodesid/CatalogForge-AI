import { describe, expect, it } from "vitest";
import { checkField, cleanTranslated } from "./checks";
import type { EnglishFields } from "./fields";

const english: EnglishFields = {
  title: "Hand-thrown Terracotta Planter",
  description_html: "<p>Hand-thrown terracotta planter with a drainage hole, 20 cm across.</p><ul><li>FSC certified wooden stand</li><li>Frost-resistant (not frost-proof, bring indoors below 0 °C)</li></ul>",
  tags: ["terracotta", "planter"],
  attributes: { material: "terracotta", care: "Bring indoors below 0 °C" },
  options: { size: ["20 cm", "30 cm"], color: ["terracotta"] },
};

const goodGerman = {
  title: "Handgedrehter Terrakotta-Übertopf",
  description_html:
    "<p>Handgedrehter Terrakotta-Übertopf mit Abflussloch, 20 cm Durchmesser.</p><ul><li>FSC-zertifizierter Holzständer</li><li>Frostbeständig (nicht frostfest, unter 0 °C ins Haus holen)</li></ul>",
  tags: ["terrakotta", "übertopf"],
  attributes: { material: { label: "Material", value: "Terrakotta" }, care: { label: "Pflege", value: "Unter 0 °C ins Haus holen" } },
  options: { size: { label: "Größe", values: { "20 cm": "20 cm", "30 cm": "30 cm" } }, color: { label: "Farbe", values: { terracotta: "Terrakotta" } } },
};

const check = (field: Parameters<typeof checkField>[0], translated: object) => checkField(field, english, { ...goodGerman, ...translated });

describe("checkField", () => {
  it("passes a faithful translation, field by field", () => {
    for (const field of ["title", "description_html", "tags", "attributes", "options"] as const) expect(check(field, {}), field).toEqual([]);
  });

  it("catches changed HTML, numbers, units, codes and placeholders", () => {
    expect(check("description_html", { description_html: goodGerman.description_html.replace("<ul>", "<ol>").replace("</ul>", "</ol>") })).toEqual(["the HTML tags changed"]);
    expect(check("description_html", { description_html: goodGerman.description_html.replace("20 cm", "zwanzig Zentimeter") })).toEqual(["the number 20 went missing"]);
    expect(check("description_html", { description_html: goodGerman.description_html.replace("20 cm", "20 Zoll") })).toEqual(["the unit changed or went missing in 20 cm"]);
    expect(check("description_html", { description_html: goodGerman.description_html.replace("FSC-zertifizierter", "Zertifizierter") })).toEqual(["FSC must stay as written"]);
    expect(check("description_html", { description_html: goodGerman.description_html.replace("Abflussloch", "Abflussloch, 2 Stück") })).toEqual(["it has number the English doesn't (2)"]);
    const withPlaceholder: EnglishFields = { title: "Set of {{count}} bowls" };
    expect(checkField("title", withPlaceholder, { title: "Set mit Schalen" })).toEqual(["the placeholders changed ({{count}})"]);
  });

  it("refuses a claim that got stronger or lost its 'not'", () => {
    // "frost-resistant (not frost-proof)" must not become frost-proof ("frostfest")
    expect(check("description_html", { description_html: goodGerman.description_html.replace("Frostbeständig (nicht frostfest,", "Frostfest (") })).toEqual([
      "it claims frost-proof, which the English doesn't",
    ]);
    const mug: EnglishFields = { description_html: "<p>Stoneware mug, 350 ml. Not dishwasher safe, hand wash only.</p>" };
    expect(checkField("description_html", mug, { description_html: "<p>Steingutbecher, 350 ml. Nicht spülmaschinenfest, nur Handwäsche.</p>" })).toEqual([]);
    expect(checkField("description_html", mug, { description_html: "<p>Steingutbecher, 350 ml. Spülmaschinenfest, nur Handwäsche.</p>" })).toEqual([
      "it claims dishwasher-safe, which the English doesn't",
    ]);
    // Seen in a real run: "workshop-made" turned into "made by craftwork", which reads as handmade
    const vase: EnglishFields = { description_html: "<p>Classic glazed vase, workshop-made.</p>" };
    expect(checkField("description_html", vase, { description_html: "<p>Klassische glasierte Vase, in Handwerksarbeit gefertigt.</p>" })).toEqual([
      "it claims handmade, which the English doesn't",
    ]);
    expect(checkField("description_html", vase, { description_html: "<p>Klassische glasierte Vase, in der Werkstatt gefertigt.</p>" })).toEqual([]);
    // French: "résistant au gel" is frost-resistant, "ingélif" is frost-proof
    const pot: EnglishFields = { title: "Frost-resistant terracotta pot" };
    expect(checkField("title", pot, { title: "Pot en terre cuite résistant au gel" })).toEqual([]);
    expect(checkField("title", pot, { title: "Pot en terre cuite ingélif" })).toEqual(["it claims frost-proof, which the English doesn't"]);
  });

  it("notices text left in English", () => {
    expect(check("description_html", { description_html: english.description_html })).toContain("it's still in English");
    const oneCopied = goodGerman.description_html.replace("Handgedrehter Terrakotta-Übertopf mit Abflussloch, 20 cm Durchmesser.", "Hand-thrown terracotta planter with a drainage hole, 20 cm across.");
    expect(check("description_html", { description_html: oneCopied })).toEqual(["a sentence was left in English"]);
  });

  it("wants every attribute and option value", () => {
    expect(check("attributes", { attributes: { material: goodGerman.attributes.material } })).toEqual(["attribute care not translated"]);
    expect(check("options", { options: { ...goodGerman.options, color: { label: "Farbe", values: {} } } })).toEqual(['option color: "terracotta" not translated']);
  });
});

describe("cleanTranslated", () => {
  it("cleans the AI's HTML like supplier HTML and keeps only what the English has", () => {
    expect(cleanTranslated("description_html", english, { description_html: "<p onclick='x()'>Hallo</p><script>bad()</script>" })).toBe("<p>Hallo</p>");
    expect(cleanTranslated("tags", english, { tags: ["Terrakotta", " terrakotta ", "Übertopf"] })).toEqual(["terrakotta", "übertopf"]);
    expect(cleanTranslated("attributes", english, { attributes: { ...goodGerman.attributes, extra: { label: "X", value: "Y" } } })).toEqual(goodGerman.attributes);
  });

  it("translates a tag that is also a colour the way the colour was translated", () => {
    // Seen in a real run: the colour "natural" was "Natur" in the options but "natürlich" ("of course") as a tag
    const basket: EnglishFields = { tags: ["rattan basket", "natural"], options: { color: ["natural"], size: ["30 cm"] } };
    const german = { tags: ["rattankorb", "natürlich"], options: { color: { label: "Farbe", values: { natural: "Natur" } }, size: { label: "Größe", values: { "30 cm": "30 cm" } } } };
    expect(cleanTranslated("tags", basket, german)).toEqual(["rattankorb", "natur"]);
    // Without the colour's translation in the same answer, the AI's tag stays
    expect(cleanTranslated("tags", basket, { tags: german.tags })).toEqual(["rattankorb", "natürlich"]);
  });

  it("starts an option value with a capital only when the English does", () => {
    // Seen in a real run: the colour "natural" was "Natur" on one product and "natur" on another
    const basket: EnglishFields = { options: { color: ["natural", "sage"], material: ["Oak"], size: ["20 cm", "XL"], finish: ["uv-resistant"] } };
    const options = (color: Record<string, string>, material: string, finish: string) => ({
      color: { label: "Farbe", values: color },
      material: { label: "Material", values: { Oak: material } },
      size: { label: "Größe", values: { "20 cm": "20 cm", XL: "XL" } },
      finish: { label: "Oberfläche", values: { "uv-resistant": finish } },
    });
    const one = cleanTranslated("options", basket, { options: options({ natural: "Natur", sage: "Salbei" }, "eiche", "UV-beständig") });
    const other = cleanTranslated("options", basket, { options: options({ natural: "natur", sage: "salbei" }, "Eiche", "UV-beständig") });
    // Lowercase like the English colours, a capital like "Oak". Sizes, "XL" and "UV" stay as written
    const expected = options({ natural: "natur", sage: "salbei" }, "Eiche", "UV-beständig");
    expect(one).toEqual(expected);
    expect(other).toEqual(expected);
    // French too: "Naturel" -> "naturel"
    const french = cleanTranslated("options", { options: { color: ["natural"] } }, { options: { color: { label: "Couleur", values: { natural: "Naturel" } } } });
    expect(french).toEqual({ color: { label: "Couleur", values: { natural: "naturel" } } });
    // The merchant's own translation is kept as they typed it
    const typed = cleanTranslated("options", basket, { options: options({ natural: "Natur", sage: "Salbei" }, "eiche", "UV-beständig") }, "merchant");
    expect(typed?.color.values).toEqual({ natural: "Natur", sage: "Salbei" });
  });
});
