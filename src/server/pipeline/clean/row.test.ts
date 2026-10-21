import { describe, expect, it } from "vitest";
import { cleanRow, normalizeSku, skuKey } from "./row";

const ctx = { defaultCurrency: "EUR", hints: {}, decimalSeparator: null } as const;

describe("SKUs", () => {
  it("are kept exactly as the supplier wrote them", () => {
    expect(normalizeSku(" FS-SÜß ")).toBe("FS-SÜß");
    expect(normalizeSku("00123")).toBe("00123");
    expect(normalizeSku("tc-pl-20")).toBe("tc-pl-20");
  });

  it("compare without caring about upper or lower case", () => {
    expect(skuKey("TC-PL-20")).toBe(skuKey("tc-pl-20"));
    expect(skuKey("FS-SÜß")).not.toBe(skuKey("FS-SÜSS"));
  });
});

describe("option columns", () => {
  it("turn Size and Colour options into size and colour, and keep other options by name", () => {
    const { cleaned } = cleanRow(
      {
        fields: { sku: "T-1", title: "Table", price: "199" },
        extra: {},
        options: [
          { name: "Farbe", value: "Grau" },
          { name: "Size", value: "120 cm" },
          { name: "Material", value: "Oak" },
        ],
        role: "variant",
      },
      ctx,
    );
    expect(cleaned).toMatchObject({ color: "grey", size: "120 cm", options: { Material: "Oak" } });
  });

  it("let the size and colour columns win over options", () => {
    const { cleaned } = cleanRow(
      { fields: { sku: "T-1", title: "Table", color: "Black" }, extra: {}, options: [{ name: "Color", value: "Red" }], role: "variant" },
      ctx,
    );
    expect(cleaned.color).toBe("black");
  });
});

describe("row roles", () => {
  it("doesn't ask for a price on a product-info row", () => {
    const { cleaned } = cleanRow({ fields: { sku: "MUG", title: "Mug" }, extra: {}, options: [], role: "product" }, ctx);
    expect(cleaned.issues.filter((i) => i.severity === "review")).toEqual([]);
  });

  it("never fails a photo-only row", () => {
    const { cleaned, failReason } = cleanRow({ fields: { image: "a.jpg", parentSku: "MUG" }, extra: {}, options: [], role: "image" }, ctx);
    expect(failReason).toBeNull();
    expect(cleaned.issues).toEqual([{ field: "image", severity: "info", message: "Extra photo for this product" }]);
  });
});
