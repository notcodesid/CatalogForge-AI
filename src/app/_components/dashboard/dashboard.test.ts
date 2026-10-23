import { describe, expect, it } from "vitest";
import { MAX_SHEET_BYTES } from "@/server/imports/create-import";
import { MAX_PHOTO_BYTES, MAX_PHOTO_REQUEST_BYTES, MAX_PHOTOS_PER_IMPORT } from "@/server/photos/upload";
import type { ImportSummary } from "./api";
import { formatBytes, formatDuration, resumingIn, timeAgo } from "./format";
import { nextStep, nowDoing, photosLine, productsLine, retryingLine, rowsLine } from "./import-progress";
import { LIMITS, PHOTO_BATCH } from "./limits";
import { EMPTY, photoBatches, sortFiles } from "./upload-files";

const file = (name: string, size = 1000) => new File([new Uint8Array(size)], name);

describe("upload limits", () => {
  it("are the server's limits, so the browser refuses exactly what the server would", () => {
    expect(LIMITS).toEqual({ sheetBytes: MAX_SHEET_BYTES, photoBytes: MAX_PHOTO_BYTES, photosPerImport: MAX_PHOTOS_PER_IMPORT, requestBytes: MAX_PHOTO_REQUEST_BYTES });
    // A batch of photos always fits in one request
    expect(PHOTO_BATCH.bytes).toBeLessThan(MAX_PHOTO_REQUEST_BYTES);
  });
});

describe("sortFiles", () => {
  it("finds the sheet, the photos and the ZIPs, and says why the rest won't be sent", () => {
    const picked = sortFiles(
      [file("prices.xlsx"), file("TC-PL-20.jpg"), file("photos.zip"), file(".DS_Store"), file("IMG_0001.HEIC"), file("notes.pdf"), file("other.csv"), file("big.jpg", MAX_PHOTO_BYTES + 1)],
      EMPTY,
    );
    expect(picked.sheet?.name).toBe("prices.xlsx");
    expect(picked.photos.map((p) => p.name)).toEqual(["TC-PL-20.jpg", "photos.zip"]);
    expect(picked.skipped).toEqual([
      { name: "IMG_0001.HEIC", reason: "HEIC photos (from iPhones) aren't supported. Export them as JPEG" },
      { name: "notes.pdf", reason: "Not a sheet (CSV, XLSX), a photo (JPEG, PNG, WebP) or a ZIP" },
      { name: "other.csv", reason: "One sheet per import. Upload this one on its own" },
      { name: "big.jpg", reason: "Over the 20 MB limit for a photo" },
    ]);
  });

  it("adds to what was picked before, without the same photo twice, and lets a new sheet replace the old one", () => {
    const first = sortFiles([file("a.csv"), file("x.jpg")], EMPTY);
    const second = sortFiles([file("b.csv"), file("x.jpg"), file("y.jpg")], first);
    expect(second.sheet?.name).toBe("b.csv");
    expect(second.photos.map((p) => p.name)).toEqual(["x.jpg", "y.jpg"]);
  });
});

describe("photoBatches", () => {
  it("sends at most 20 files or 60 MB per request, a big ZIP on its own", () => {
    const photos = Array.from({ length: 45 }, (_, i) => file(`p${i}.jpg`, 10));
    expect(photoBatches(photos).map((b) => b.length)).toEqual([20, 20, 5]);
    const zip = file("all.zip", PHOTO_BATCH.bytes + 1);
    expect(photoBatches([file("a.jpg"), zip, file("b.jpg")]).map((b) => b.map((f) => f.name))).toEqual([["a.jpg"], ["all.zip"], ["b.jpg"]]);
  });
});

describe("format", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  it("writes sizes, ages and durations the way people read them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(timeAgo("2026-10-22T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-10-22T11:56:00Z", now)).toBe("4 min ago");
    expect(timeAgo("2026-10-20T12:00:00Z", now)).toBe("2 days ago");
    expect(formatDuration(192_000)).toBe("3 min 12 s");
    expect(formatDuration(3_840_000)).toBe("1 h 4 min");
    expect(resumingIn("2026-10-22T12:02:30Z", now)).toBe("resuming in 3 minutes");
    expect(resumingIn("2026-10-22T11:59:00Z", now)).toBe("resuming now");
  });
});

describe("import progress on the Upload tab", () => {
  const summary = (over: Partial<ImportSummary> = {}): ImportSummary => ({
    id: "imp-1",
    fileName: "round1_sheet.csv",
    status: "running",
    stage: "build",
    phase: "writing products",
    pausedUntil: null,
    pauseReason: null,
    retrying: null,
    error: null,
    totalRows: 13,
    rows: { pending: 6, processing: 2, done: 4, needs_review: 1, failed: 0 },
    products: 4,
    productOutcomes: { new: 0, updated: 0, deleted: 0, failed: 0 },
    photos: { total: 14, pending: 14, matched: 0, unmatched: 0, rejected: 0, waitingToBeProcessed: 14, linksOverLimit: 0, missing: [] },
    translations: { de: { done: 0, pending: 0, failed: 0 }, fr: { done: 0, pending: 0, failed: 0 } },
    createdAt: "2026-10-22T12:00:00Z",
    startedAt: "2026-10-22T12:00:01Z",
    finishedAt: null,
    defaultCurrency: "EUR",
    rowsWithReviewIssues: 0,
    earlierFiles: [],
    productsByStatus: {},
    parseInfo: null,
    ...over,
  });

  it("says what it's doing while it runs", () => {
    expect(nowDoing(summary())).toBe("Writing products: 5 of 13 rows done");
    expect(nowDoing(summary({ phase: "translating", translations: { de: { done: 3, pending: 3, failed: 0 }, fr: { done: 2, pending: 4, failed: 0 } } }))).toBe(
      "Translating: German 3 of 6, French 2 of 6",
    );
    expect(nowDoing(summary({ phase: "reading the sheet" }))).toBe("Reading the sheet…");
  });

  it("says when the AI failed and it's trying again", () => {
    expect(retryingLine({ products: 3, attempt: 2, attempts: 4 })).toBe("The AI returned an error for 3 products. Trying again: try 2 of 4");
    expect(retryingLine({ products: 1, attempt: 4, attempts: 4 })).toBe("The AI returned an error for 1 product. Trying again: try 4 of 4");
  });

  it("says the photos arrived, then what came of them", () => {
    expect(photosLine(summary())).toBe("14 photos received, matching them to products…");
    const matched = summary({ photos: { ...summary().photos, pending: 0, matched: 12, unmatched: 2 } });
    expect(photosLine(matched)).toBe("14 photos: 12 matched · 2 unmatched");
    expect(photosLine(summary({ photos: { ...summary().photos, total: 0, pending: 0 } }))).toBeNull();
  });

  it("sums up the rows and leads to the products waiting for review", () => {
    const done = summary({ status: "done", rows: { pending: 0, processing: 0, done: 11, needs_review: 2, failed: 0 }, productsByStatus: { ready: 3, needs_review: 2 } });
    expect(rowsLine(done)).toBe("13 rows: 11 done · 2 need review · 0 failed");
    expect(nextStep(done)).toEqual({ href: "/products?import=imp-1&status=needs_review", label: "Review 2 products" });
    expect(nextStep(summary({ status: "done", productsByStatus: { ready: 4 } }))).toEqual({ href: "/products?import=imp-1", label: "See the 4 products" });
  });

  it("says which products were new and which were already in the catalog, and from which file", () => {
    const outcomes = (o: Partial<ImportSummary["productOutcomes"]>) => ({ new: 0, updated: 0, deleted: 0, failed: 0, ...o });
    const level1 = summary({ fileName: "level1_basic.csv", products: 6, productOutcomes: outcomes({ new: 4, updated: 2 }) });
    // In the list, and while it runs, the earlier files aren't known yet
    expect(productsLine(level1)).toBe("6 products: 4 new, 2 already in your catalog (updated)");
    expect(productsLine({ ...level1, earlierFiles: ["shopify_products_export.csv"] })).toBe(
      "6 products: 4 new, 2 already in your catalog from shopify_products_export.csv (updated)",
    );
    expect(productsLine({ ...level1, earlierFiles: ["a.csv", "b.csv", "c.csv"] })).toBe("6 products: 4 new, 2 already in your catalog from a.csv and 2 other files (updated)");

    // The same file again
    const again = summary({ products: 12, productOutcomes: outcomes({ updated: 11, deleted: 1 }), earlierFiles: ["round1_sheet.csv", "old.csv"] });
    expect(productsLine(again)).toBe("12 products: 11 already in your catalog from an earlier upload of this file and old.csv (updated), 1 skipped (you deleted it)");

    expect(productsLine(summary({ products: 6, productOutcomes: outcomes({ new: 6 }) }))).toBe("6 new products");
    expect(productsLine(summary({ products: 6, productOutcomes: outcomes({ new: 5, failed: 1 }) }))).toBe("6 products: 5 new, 1 failed");
    // Still being written
    expect(productsLine(summary({ products: 6, productOutcomes: outcomes({}) }))).toBe("6 products");
  });
});
