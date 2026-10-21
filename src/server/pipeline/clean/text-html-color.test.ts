import { describe, expect, it } from "vitest";
import { normalizeColor } from "./color";
import { cleanDescription } from "./html";
import { detectLanguage } from "./language";
import { cleanText, fixMojibake } from "./text";

describe("text", () => {
  it("repairs UTF-8 text that was read as Windows-1252", () => {
    expect(fixMojibake("GrÃ¼n")).toBe("Grün");
    expect(fixMojibake("TerrakottÃ¤")).toBe("Terrakottä");
    expect(fixMojibake("Itâ€™s")).toBe("It’s");
  });

  it("leaves correct text alone", () => {
    expect(fixMojibake("Grün")).toBe("Grün");
    expect(fixMojibake("Ålesund")).toBe("Ålesund");
  });

  it("trims and squeezes spaces, and treats empty cells as null", () => {
    expect(cleanText("  Hand-thrown \u00a0Planter\u200b ")).toBe("Hand-thrown Planter");
    expect(cleanText("   ")).toBeNull();
  });
});

describe("cleanDescription", () => {
  it("removes scripts and event handlers but keeps basic formatting", () => {
    const result = cleanDescription(`<p>Glazed vase.</p><script>alert('xss')</script><img src=x onerror="alert(1)">`);
    expect(result).toEqual({ html: "<p>Glazed vase.</p>", text: "Glazed vase.", removedUnsafe: true });
  });

  it("turns <b> into <strong> and wraps plain text in a paragraph", () => {
    expect(cleanDescription("Stoneware mug. <b>Not dishwasher safe</b>")?.html).toBe(
      "<p>Stoneware mug. <strong>Not dishwasher safe</strong></p>",
    );
  });
});

describe("normalizeColor", () => {
  it.each([
    ["terracota", "terracotta"],
    ["Terrakotta", "terracotta"],
    ["Gray", "grey"],
    ["grau", "grey"],
    ["Grün", "green"],
    ["Natur", "natural"],
    ["Dark Grey", "dark grey"],
    ["gery", "grey"],
    ["blck", "black"],
    ["Natrual", "natural"],
    ["Sage", "sage"],
    ["Natural/Grey", "natural/grey"],
    ["Argenté", "silver"],
  ])("%s -> %s", (raw, value) => {
    expect(normalizeColor(raw)).toMatchObject({ value, known: true });
  });

  it("keeps colours it doesn't know instead of guessing", () => {
    expect(normalizeColor("Aubergine")).toEqual({ value: "aubergine", known: false, source: "Aubergine" });
  });
});

describe("detectLanguage", () => {
  it("spots German and English", () => {
    expect(detectLanguage(["Keramik Übertopf, handgemacht", "Handgemachter Übertopf aus Keramik. Nicht frostfest."])).toBe("de");
    expect(detectLanguage(["Watering Can", "Galvanised steel watering can, 5 L."])).toBe("en");
  });
});
