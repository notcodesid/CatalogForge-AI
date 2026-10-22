import { describe, expect, it } from "vitest";
import { MAX_SHEET_BYTES } from "@/server/imports/create-import";
import { MAX_PHOTO_BYTES, MAX_PHOTO_REQUEST_BYTES, MAX_PHOTOS_PER_IMPORT } from "@/server/photos/upload";
import { formatBytes, formatDuration, resumingIn, timeAgo } from "./format";
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
