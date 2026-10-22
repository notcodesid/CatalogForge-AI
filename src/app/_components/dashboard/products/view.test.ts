import { describe, expect, it } from "vitest";
import { CATEGORIES } from "@/server/ai/taxonomy";
import {
  categoryGroups,
  categoryLeaf,
  confidenceLabel,
  confidenceTone,
  decodeTranslation,
  DEFAULT_VIEW,
  hasFilters,
  priceRange,
  readView,
  tagsFromText,
  textFromEarlierFile,
  toggleSort,
  viewToApiQuery,
  viewToSearch,
  withChange,
} from "./view";

const read = (query: string) => readView(new URLSearchParams(query));

describe("the view in the address bar", () => {
  it("reads a plain address as the default view, and writes it back as nothing", () => {
    expect(read("")).toEqual(DEFAULT_VIEW);
    expect(viewToSearch(DEFAULT_VIEW)).toBe("");
  });

  it("survives a round trip through the address", () => {
    const view = read("q=planter&status=needs_review,ready&category=Home+%26+Garden&import=0c52ef82-12c8-40d9-aa2e-eaf649854bf3&low=1&sort=confidence&pageSize=50&page=3");
    expect(view).toMatchObject({
      search: "planter",
      status: ["needs_review", "ready"],
      category: "Home & Garden",
      importId: "0c52ef82-12c8-40d9-aa2e-eaf649854bf3",
      lowConfidence: true,
      sort: "confidence",
      order: "asc",
      pageSize: 50,
      page: 3,
    });
    expect(read(viewToSearch(view).slice(1))).toEqual(view);
  });

  it("falls back to the default for anything it doesn't know", () => {
    expect(read("sort=price;drop&order=sideways&pageSize=7&page=-2&status=lost,approved&import=not-an-id")).toEqual({
      ...DEFAULT_VIEW,
      status: ["approved"],
    });
  });

  it("turns the view into the API's query, with low confidence meaning under the review threshold", () => {
    const query = new URLSearchParams(viewToApiQuery(withChange(DEFAULT_VIEW, { lowConfidence: true, deleted: true, search: "mug" })));
    expect(Object.fromEntries(query)).toEqual({
      page: "1",
      pageSize: "25",
      sort: "updatedAt",
      order: "desc",
      search: "mug",
      maxConfidence: "69",
      deleted: "true",
    });
  });

  it("goes back to the first page when the filters change, but not when turning pages", () => {
    const onPage4 = { ...DEFAULT_VIEW, page: 4 };
    expect(withChange(onPage4, { status: ["ready"] }).page).toBe(1);
    expect(withChange(onPage4, { page: 5 }).page).toBe(5);
    expect(hasFilters(withChange(onPage4, { status: ["ready"] }))).toBe(true);
    expect(hasFilters(onPage4)).toBe(false);
  });

  it("flips the direction on the same column, and starts a new column in its natural direction", () => {
    const byTitle = toggleSort(DEFAULT_VIEW, "title");
    expect(byTitle).toMatchObject({ sort: "title", order: "asc" });
    expect(toggleSort(byTitle, "title")).toMatchObject({ sort: "title", order: "desc" });
    expect(toggleSort(byTitle, "updatedAt")).toMatchObject({ sort: "updatedAt", order: "desc" });
  });
});

describe("confidence colours", () => {
  it("is green from 90, amber from 70 (the review threshold), red below", () => {
    expect([95, 90, 89, 70, 69, 12].map(confidenceTone)).toEqual(["success", "success", "warning", "warning", "danger", "danger"]);
    expect(confidenceTone(null)).toBe("neutral");
    expect(confidenceLabel(84.6)).toBe("85%");
    expect(confidenceLabel(null)).toBe("No score");
  });
});

describe("prices and categories", () => {
  it("shows one price, a range, mixed currencies or nothing", () => {
    const row = { minPriceCents: 2499, maxPriceCents: 2499, currency: "EUR", currencies: ["EUR"] };
    expect(priceRange(row)).toBe("€24.99");
    expect(priceRange({ ...row, maxPriceCents: 3990 })).toBe("€24.99 – €39.90");
    expect(priceRange({ ...row, currency: null, currencies: ["EUR", "GBP"] })).toBe("Mixed currencies");
    expect(priceRange({ ...row, minPriceCents: null, maxPriceCents: null })).toBeNull();
  });

  it("groups the category list by its top level", () => {
    const groups = categoryGroups(CATEGORIES);
    expect(groups.find((g) => g.top === "Home & Garden")?.children).toContain("Home & Garden > Kitchen & Dining > Kitchen Tools");
    expect(groups.find((g) => g.top === "Other")?.children).toEqual([]);
    expect(categoryLeaf("Home & Garden > Kitchen & Dining > Kitchen Tools")).toBe("Kitchen Tools");
  });
});

describe("the text a listing was written from", () => {
  const written = [{ cells: { Description: "Hand-thrown planter with drainage hole.", Notes: "Tom & Jerry edition. A very long note that…" } }];
  const variantRow = (raw: Record<string, string>) => ({ raw: { "Supplier SKU": "TC-PL-20", Price: "24,99 €", ...raw } });

  it("is the sheet on file, even with HTML, entities and long cells cut short", () => {
    const rows = [
      variantRow({ Description: "<p>Hand-thrown planter with <strong>drainage</strong> hole.</p>", Notes: "Tom &amp; Jerry edition. A very long note that goes on" }),
      variantRow({ Description: "", Notes: "" }),
    ];
    expect(textFromEarlierFile(written, rows)).toBe(false);
  });

  it("came from an earlier file when the sheet now is a price list", () => {
    expect(textFromEarlierFile(written, [variantRow({})])).toBe(true);
    expect(textFromEarlierFile(written, [])).toBe(true);
  });
});

describe("translation values", () => {
  it("reads text fields as they are and the rest as JSON", () => {
    expect(decodeTranslation("title", "Steingutbecher")).toBe("Steingutbecher");
    expect(decodeTranslation("tags", '["becher","steingut"]')).toEqual(["becher", "steingut"]);
    expect(decodeTranslation("attributes", "not json")).toBeNull();
    expect(tagsFromText(" Becher, steingut ,, Becher")).toEqual(["becher", "steingut"]);
  });
});
