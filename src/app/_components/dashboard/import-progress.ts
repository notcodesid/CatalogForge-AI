import type { ImportListItem, ImportSummary } from "./api";
import { capitalize, formatCount } from "./format";
import { LANGUAGE_NAMES } from "./statuses";

// What the Upload tab says about the import the merchant just started, and the products line of every import card,
// kept apart from the components so it can be tested

const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;

// What it's doing now: "Writing products: 5 of 13 rows done", "Translating: German 3 of 6, French 2 of 6"
export function nowDoing(s: ImportSummary): string {
  if (s.phase === "writing products") {
    const total = s.totalRows ?? Object.values(s.rows).reduce((a, b) => a + b, 0);
    const finished = s.rows.done + s.rows.needs_review + s.rows.failed;
    return total ? `Writing products: ${formatCount(finished)} of ${plural(total, "row")} done` : "Writing products…";
  }
  if (s.phase === "translating") {
    const languages = Object.entries(s.translations)
      .map(([locale, t]) => ({ name: LANGUAGE_NAMES[locale] ?? locale.toUpperCase(), done: t.done, all: t.done + t.pending + t.failed }))
      .filter((l) => l.all > 0);
    return languages.length ? `Translating: ${languages.map((l) => `${l.name} ${formatCount(l.done)} of ${formatCount(l.all)}`).join(", ")}` : "Translating…";
  }
  return `${capitalize(s.phase)}…`;
}

// "14 photos received, matching them to products…" until they're matched, then what came of them
export function photosLine(s: ImportSummary): string | null {
  const p = s.photos;
  if (!p.total) return null;
  if (p.pending > 0) return `${plural(p.total, "photo")} received, matching them to products…`;
  const parts = [
    p.matched > 0 && `${formatCount(p.matched)} matched`,
    p.unmatched > 0 && `${formatCount(p.unmatched)} unmatched`,
    p.rejected > 0 && `${formatCount(p.rejected)} rejected`,
  ].filter(Boolean);
  return `${plural(p.total, "photo")}: ${parts.join(" · ")}`;
}

// "13 rows: 11 done · 2 need review · 0 failed"
export function rowsLine(s: ImportSummary): string {
  const { done, needs_review, failed } = s.rows;
  return `${plural(done + needs_review + failed, "row")}: ${formatCount(done)} done · ${formatCount(needs_review)} need${needs_review === 1 ? "s" : ""} review · ${formatCount(failed)} failed`;
}

// "6 products: 4 new, 2 already in your catalog (updated)". The same products uploaded again (same SKU or product
// key, even from a differently laid out file) update the ones in the catalog instead of adding copies, so this says
// how many it updated, and from which earlier files once the import is done. "6 new products" when all are new
export function productsLine(s: Pick<ImportListItem, "fileName" | "products" | "productOutcomes"> & { earlierFiles?: string[] }): string {
  const { new: added, updated, deleted, failed } = s.productOutcomes;
  if (added > 0 && added === s.products) return plural(added, "new product");
  const from = s.earlierFiles?.length ? ` from ${fileList(s.earlierFiles, s.fileName)}` : "";
  const parts = [
    added > 0 && `${formatCount(added)} new`,
    updated > 0 && `${formatCount(updated)} already in your catalog${from} (updated)`,
    deleted > 0 && `${formatCount(deleted)} skipped (you deleted ${deleted === 1 ? "it" : "them"})`,
    failed > 0 && `${formatCount(failed)} failed`,
  ].filter(Boolean);
  return parts.length ? `${plural(s.products, "product")}: ${parts.join(", ")}` : plural(s.products, "product");
}

// "a.csv", "a.csv and b.csv", "a.csv and 2 other files". The same file uploaded before is "an earlier upload of this file"
function fileList(files: string[], current: string) {
  const names = files.map((f) => (f === current ? "an earlier upload of this file" : f));
  return names.length <= 2 ? names.join(" and ") : `${names[0]} and ${names.length - 1} other files`;
}

// The next thing to do once it's finished: the products waiting for the merchant, or all of them when none are
export function nextStep(s: ImportSummary): { href: string; label: string } {
  const waiting = s.productsByStatus.needs_review ?? 0;
  return waiting > 0
    ? { href: `/products?import=${s.id}&status=needs_review`, label: `Review ${plural(waiting, "product")}` }
    : { href: `/products?import=${s.id}`, label: s.products === 1 ? "See the product" : `See the ${formatCount(s.products)} products` };
}
