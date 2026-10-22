import { formatBytes } from "./format";
import { HEIC_EXTENSIONS, LIMITS, PHOTO_BATCH, PHOTO_EXTENSIONS, SHEET_EXTENSIONS, ZIP_EXTENSION } from "./limits";

// What the Upload tab does with the files the merchant picks, kept apart from the component so it can be tested

export type Skipped = { name: string; reason: string };
export type Picked = { sheet: File | null; photos: File[]; skipped: Skipped[] };

export const EMPTY: Picked = { sheet: null, photos: [], skipped: [] };
export const isZip = (file: File) => ZIP_EXTENSION.test(file.name);

// Sorts what the merchant dropped into the sheet, the photos (and ZIPs of photos) and files that won't be sent,
// each with the reason. Checked against the server's limits, so nobody waits for an upload that will be refused
export function sortFiles(files: File[], current: Picked): Picked {
  const next: Picked = { sheet: current.sheet, photos: [...current.photos], skipped: [] };
  let sheetsInThisDrop = 0;
  const seen = new Set(next.photos.map((p) => `${p.name}:${p.size}`));
  for (const file of files) {
    // Hidden files a computer adds by itself (.DS_Store and the like)
    if (file.name.startsWith(".")) continue;
    if (SHEET_EXTENSIONS.test(file.name)) {
      if (++sheetsInThisDrop > 1) {
        next.skipped.push({ name: file.name, reason: "One sheet per import. Upload this one on its own" });
        continue;
      }
      if (file.size > LIMITS.sheetBytes) next.skipped.push({ name: file.name, reason: `Over the ${formatBytes(LIMITS.sheetBytes)} limit for a sheet` });
      else next.sheet = file;
    } else if (HEIC_EXTENSIONS.test(file.name)) {
      next.skipped.push({ name: file.name, reason: "HEIC photos (from iPhones) aren't supported. Export them as JPEG" });
    } else if (PHOTO_EXTENSIONS.test(file.name) || isZip(file)) {
      const limit = isZip(file) ? LIMITS.requestBytes : LIMITS.photoBytes;
      if (file.size > limit) {
        next.skipped.push({ name: file.name, reason: isZip(file) ? `ZIPs over ${formatBytes(limit)} can't be sent in one piece. Split it` : `Over the ${formatBytes(limit)} limit for a photo` });
      } else if (!seen.has(`${file.name}:${file.size}`)) {
        seen.add(`${file.name}:${file.size}`);
        next.photos.push(file);
      }
    } else {
      next.skipped.push({ name: file.name, reason: "Not a sheet (CSV, XLSX), a photo (JPEG, PNG, WebP) or a ZIP" });
    }
  }
  return next;
}

// Photos go in several small requests, so a big folder never makes one huge upload, and a dropped connection
// only repeats one batch. A ZIP bigger than a batch goes on its own
export function photoBatches(files: File[]): File[][] {
  const batches: File[][] = [];
  let current: File[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length && (current.length >= PHOTO_BATCH.files || bytes + file.size > PHOTO_BATCH.bytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}
