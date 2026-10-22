import { formatPrice } from "../format";
import type { Tone } from "../ui";
import type { ProductRow, ProductStatus, TranslatedField, Variant } from "./api";
import { CONFIDENCE_THRESHOLD } from "@/server/ai/confidence";

// The Products tab's view (filters, sort, page) lives in the address bar, so it survives a reload and can be
// shared as a link. These helpers turn the address into a view and back, and the view into the API's query

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const SORTS = ["title", "status", "category", "updatedAt", "confidence", "price"] as const;
export type Sort = (typeof SORTS)[number];

export const PRODUCT_STATUSES: ProductStatus[] = ["needs_review", "ready", "approved"];

// Under this the AI was unsure about a field and the product went to review: the same number the server uses
export const REVIEW_THRESHOLD = CONFIDENCE_THRESHOLD;

export type ListView = {
  page: number;
  pageSize: PageSize;
  sort: Sort;
  order: "asc" | "desc";
  search: string;
  status: ProductStatus[];
  category: string;
  importId: string;
  lowConfidence: boolean;
  // Approved products with a new version of their listing waiting
  updateWaiting: boolean;
  deleted: boolean;
};

// Newest changes first. Any other column starts from the top: A to Z, the least certain first, the cheapest first
const defaultOrder = (sort: Sort): "asc" | "desc" => (sort === "updatedAt" ? "desc" : "asc");

export const DEFAULT_VIEW: ListView = {
  page: 1,
  pageSize: 25,
  sort: "updatedAt",
  order: "desc",
  search: "",
  status: [],
  category: "",
  importId: "",
  lowConfidence: false,
  updateWaiting: false,
  deleted: false,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An old or hand-edited address can't break the page: anything unknown falls back to the default
export function readView(params: URLSearchParams): ListView {
  const sort = SORTS.find((s) => s === params.get("sort")) ?? DEFAULT_VIEW.sort;
  const order = params.get("order");
  const status = (params.get("status") ?? "").split(",").filter((s): s is ProductStatus => (PRODUCT_STATUSES as string[]).includes(s));
  const importId = params.get("import") ?? "";
  return {
    page: Math.max(1, Math.floor(Number(params.get("page")) || 1)),
    pageSize: PAGE_SIZES.find((n) => String(n) === params.get("pageSize")) ?? DEFAULT_VIEW.pageSize,
    sort,
    order: order === "asc" || order === "desc" ? order : defaultOrder(sort),
    search: (params.get("q") ?? "").slice(0, 200),
    status: [...new Set(status)],
    category: (params.get("category") ?? "").slice(0, 300),
    importId: UUID.test(importId) ? importId : "",
    lowConfidence: params.get("low") === "1",
    updateWaiting: params.get("update") === "1",
    deleted: params.get("deleted") === "1",
  };
}

// The view as an address. Only what differs from the default is written, so a plain /products stays plain
export function viewToSearch(view: ListView): string {
  const p = new URLSearchParams();
  if (view.search) p.set("q", view.search);
  if (view.status.length) p.set("status", view.status.join(","));
  if (view.category) p.set("category", view.category);
  if (view.importId) p.set("import", view.importId);
  if (view.lowConfidence) p.set("low", "1");
  if (view.updateWaiting) p.set("update", "1");
  if (view.deleted) p.set("deleted", "1");
  if (view.sort !== DEFAULT_VIEW.sort) p.set("sort", view.sort);
  if (view.order !== defaultOrder(view.sort)) p.set("order", view.order);
  if (view.pageSize !== DEFAULT_VIEW.pageSize) p.set("pageSize", String(view.pageSize));
  if (view.page !== 1) p.set("page", String(view.page));
  const query = p.toString();
  return query ? `?${query}` : "";
}

// The same view as GET /api/products's query string
export function viewToApiQuery(view: ListView): string {
  const p = new URLSearchParams({ page: String(view.page), pageSize: String(view.pageSize), sort: view.sort, order: view.order });
  if (view.search) p.set("search", view.search);
  if (view.status.length) p.set("status", view.status.join(","));
  if (view.category) p.set("category", view.category);
  if (view.importId) p.set("importId", view.importId);
  // "Low confidence" = a field under the review threshold
  if (view.lowConfidence) p.set("maxConfidence", String(REVIEW_THRESHOLD - 1));
  if (view.updateWaiting) p.set("updateWaiting", "true");
  if (view.deleted) p.set("deleted", "true");
  return p.toString();
}

// Changing what's shown goes back to the first page (page 7 of the old filter may not exist). A new sort column
// starts in its natural direction
export function withChange(view: ListView, change: Partial<ListView>): ListView {
  const next = { ...view, ...change };
  if (!("page" in change)) next.page = 1;
  if ("sort" in change && !("order" in change)) next.order = defaultOrder(next.sort);
  return next;
}

// Clicking a column header: the same column flips direction, another column starts in its natural direction
export function toggleSort(view: ListView, sort: Sort): ListView {
  return view.sort === sort ? withChange(view, { order: view.order === "asc" ? "desc" : "asc" }) : withChange(view, { sort });
}

export const hasFilters = (view: ListView) =>
  Boolean(view.search || view.status.length || view.category || view.importId || view.lowConfidence || view.updateWaiting || view.deleted);

export const PRODUCT_STATUS_LABEL: Record<ProductStatus, { label: string; tone: Tone }> = {
  needs_review: { label: "Needs review", tone: "warning" },
  ready: { label: "Ready", tone: "info" },
  approved: { label: "Approved", tone: "success" },
};

// Green when the AI was sure (90+), amber when fairly sure (70 to 89), red under 70: those went to review
export function confidenceTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined) return "neutral";
  if (value >= 90) return "success";
  if (value >= REVIEW_THRESHOLD) return "warning";
  return "danger";
}

export const confidenceLabel = (value: number | null | undefined) => (value === null || value === undefined ? "No score" : `${Math.round(value)}%`);

// The AI names its fields "title", "description", "category", "tags" and "attributes.<name>"
export function fieldConfidence(confidence: Record<string, number>, field: string): number | null {
  return confidence[field] ?? null;
}

// "€24.99", "€24.99 – €39.90", "Mixed currencies" (variants priced in two currencies), or null (no price at all)
export function priceRange(row: Pick<ProductRow, "minPriceCents" | "maxPriceCents" | "currency" | "currencies">): string | null {
  if (row.minPriceCents === null) return null;
  if (!row.currency) return row.currencies.length > 1 ? "Mixed currencies" : null;
  const min = formatPrice(row.minPriceCents, row.currency);
  if (row.maxPriceCents === null || row.maxPriceCents === row.minPriceCents) return min;
  return `${min} – ${formatPrice(row.maxPriceCents, row.currency)}`;
}

// "Sheet says €34.00" next to a price the merchant typed, when the supplier's sheet now gives a different one (theirs
// stays until they change it). Null otherwise
export function sheetSays(variant: Pick<Variant, "priceSetByHand" | "priceCents" | "currency" | "sheetPriceCents" | "sheetCurrency">): string | null {
  if (!variant.priceSetByHand || variant.sheetPriceCents === null) return null;
  if (variant.sheetPriceCents === variant.priceCents && variant.sheetCurrency === variant.currency) return null;
  const price = formatPrice(variant.sheetPriceCents, variant.sheetCurrency);
  return price && `Sheet says ${price}`;
}

// "Home & Garden > Kitchen & Dining > Kitchen Tools" -> "Kitchen Tools", the part that says the most
export const categoryLeaf = (category: string | null) => (category ? (category.split(" > ").at(-1) ?? category) : null);

// The top of each category path, for the filter ("Home & Garden" includes everything under it)
export function categoryGroups(categories: readonly string[]): { top: string; children: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const category of categories) {
    const top = category.split(" > ")[0];
    groups.set(top, [...(groups.get(top) ?? []), category]);
  }
  return [...groups].map(([top, children]) => ({ top, children: children.filter((c) => c !== top) }));
}

// Is some of the text the listing was written from missing from the sheet on file now? That happens after a
// prices-only re-upload (a price list without descriptions keeps the listing of the earlier, richer file), and is
// worth showing. Compared word by word, since the AI saw the text cleaned: no HTML, long cells cut short
export function textFromEarlierFile(writtenFrom: { cells: Record<string, string> }[], rows: { raw: Record<string, string> }[]): boolean {
  const words = (text: string) =>
    text
      .replace(/<[^>]*>|&[a-z]+;|&#\d+;/gi, " ")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const current = rows.flatMap((r) => Object.values(r.raw)).map((value) => words(value ?? ""));
  return writtenFrom.some((r) =>
    Object.values(r.cells).some((text) => {
      const w = words(text);
      return w !== "" && !current.some((c) => c.includes(w));
    }),
  );
}

// Translations are stored as text: titles and descriptions as they are, tags, attributes and options as JSON
export function decodeTranslation(field: TranslatedField, value: string): unknown {
  if (field === "title" || field === "description_html") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Tags are edited as one line: "terracotta, planter, outdoor"
export const tagsFromText = (text: string) => [...new Set(text.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];
export const tagsToText = (tags: string[]) => tags.join(", ");

export const FIELD_LABEL: Record<TranslatedField, string> = {
  title: "Title",
  description_html: "Description",
  tags: "Tags",
  attributes: "Attributes",
  options: "Variant options",
};

// "material" -> "Material", "color" -> "Colour" (the same names the storefront uses in English)
export function humanize(key: string) {
  if (key.toLowerCase() === "color") return "Colour";
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
}
