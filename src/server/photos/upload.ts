import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, count, eq, ne } from "drizzle-orm";
import yauzl from "yauzl";
import type { Db } from "@/server/db/client";
import { photos } from "@/server/db/schema";
import { UploadError } from "@/server/imports/upload-error";
import { saveFile } from "@/server/storage";

export const MAX_PHOTOS_PER_IMPORT = 2000;
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
// One upload request, photos and ZIPs together. A bigger set is sent in several requests
export const MAX_PHOTO_REQUEST_BYTES = 300 * 1024 * 1024;
// Everything inside one ZIP once unpacked. Stops a small ZIP that unpacks into gigabytes
const MAX_ZIP_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;

export type UploadedFile = { name: string; bytes: Uint8Array };
type Accepted = { fileName: string; bytes: Uint8Array; ext: string };
type Refused = { fileName: string; reason: string };
export type UnpackedPhotos = { accepted: Accepted[]; refused: Refused[] };


const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

// What a file really is, from its first bytes. The name can't be trusted ("photo.jpg" may be a PDF)
export function fileKind(bytes: Uint8Array): "jpeg" | "png" | "webp" | "zip" | "heic" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") return "png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  if (ascii(bytes, 0, 2) === "PK" && (bytes[2] === 3 || bytes[2] === 5)) return "zip";
  if (ascii(bytes, 4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1)/.test(ascii(bytes, 8, 12))) return "heic";
  return null;
}

// Files a computer adds on its own: macOS resource forks, folder settings. Skipped without a word
function isJunk(fileName: string) {
  const base = path.posix.basename(fileName);
  return fileName.startsWith("__MACOSX/") || base.startsWith("._") || [".DS_Store", "Thumbs.db", "desktop.ini"].includes(base);
}

function classify(fileName: string, bytes: Uint8Array, insideZip: boolean): Accepted | Refused {
  const kind = fileKind(bytes);
  if (kind === "zip") return { fileName, reason: insideZip ? "A ZIP inside a ZIP isn't supported. Unpack it first" : "Unexpected ZIP" };
  if (kind === "heic") return { fileName, reason: "HEIC photos (from iPhones) aren't supported. Export them as JPEG" };
  if (!kind) return { fileName, reason: "Not a photo. Use JPEG, PNG or WebP" };
  if (bytes.length > MAX_PHOTO_BYTES) return { fileName, reason: `Too big (${mb(bytes.length)}). The limit is ${mb(MAX_PHOTO_BYTES)} per photo` };
  return { fileName, bytes, ext: kind === "jpeg" ? ".jpg" : `.${kind}` };
}

function mb(bytes: number) {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

// The photos inside a ZIP. Damaged or password-protected ZIPs and entries are refused with a reason
async function unzip(zipName: string, bytes: Uint8Array): Promise<UnpackedPhotos> {
  const result: UnpackedPhotos = { accepted: [], refused: [] };
  let zip: yauzl.ZipFile;
  try {
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, validateEntrySizes: true }, (err, z) => (err ? reject(err) : resolve(z))),
    );
  } catch {
    return { accepted: [], refused: [{ fileName: zipName, reason: "This ZIP can't be opened. It may be damaged" }] };
  }

  let unpacked = 0;
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", (entry: yauzl.Entry) => {
      const name = entry.fileName;
      const next = () => zip.readEntry();
      if (name.endsWith("/") || isJunk(name)) return next();
      if (entry.isEncrypted()) {
        result.refused.push({ fileName: name, reason: "Password protected inside the ZIP" });
        return next();
      }
      if (entry.uncompressedSize > MAX_PHOTO_BYTES) {
        result.refused.push({ fileName: name, reason: `Too big (${mb(entry.uncompressedSize)}). The limit is ${mb(MAX_PHOTO_BYTES)} per photo` });
        return next();
      }
      unpacked += entry.uncompressedSize;
      if (unpacked > MAX_ZIP_UNPACKED_BYTES) return reject(new UploadError(`"${zipName}" unpacks to more than ${mb(MAX_ZIP_UNPACKED_BYTES)}`, 413));
      zip.openReadStream(entry, (err, stream) => {
        if (err) {
          result.refused.push({ fileName: name, reason: "Can't be unpacked. The ZIP may be damaged" });
          return next();
        }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", () => {
          result.refused.push({ fileName: name, reason: "Can't be unpacked. The ZIP may be damaged" });
          next();
        });
        stream.on("end", () => {
          const entryResult = classify(name, Buffer.concat(chunks), true);
          if ("bytes" in entryResult) result.accepted.push(entryResult);
          else result.refused.push(entryResult);
          next();
        });
      });
    });
    zip.readEntry();
  }).catch((err: unknown) => {
    if (err instanceof UploadError) throw err;
    result.refused.push({ fileName: zipName, reason: "This ZIP can't be read to the end. It may be damaged" });
  });
  return result;
}

// Turns what the merchant sent (photos and ZIPs of photos) into photos we accept and files we refuse, with why.
// Nothing is saved yet
export async function unpackPhotos(files: UploadedFile[]): Promise<UnpackedPhotos> {
  const result: UnpackedPhotos = { accepted: [], refused: [] };
  for (const file of files) {
    const name = path.posix.basename(file.name.replace(/\\/g, "/"));
    if (isJunk(name)) continue;
    if (fileKind(file.bytes) === "zip") {
      const inside = await unzip(name, file.bytes);
      result.accepted.push(...inside.accepted);
      result.refused.push(...inside.refused);
      continue;
    }
    const one = classify(name, file.bytes, false);
    if ("bytes" in one) result.accepted.push(one);
    else result.refused.push(one);
  }
  return result;
}

// Saves photos for an import that's still waiting for its files. Each photo is stored as it arrived and processed
// later in the background. Sending a file with the same name again does nothing, so a retried upload is safe
export async function savePhotos(db: Db, importId: string, unpacked: UnpackedPhotos) {
  const [{ existing }] = await db
    .select({ existing: count() })
    .from(photos)
    .where(and(eq(photos.importId, importId), ne(photos.status, "rejected")));
  if (existing + unpacked.accepted.length > MAX_PHOTOS_PER_IMPORT) {
    throw new UploadError(
      `An import can have at most ${MAX_PHOTOS_PER_IMPORT.toLocaleString("en")} photos. This upload would make it ${(existing + unpacked.accepted.length).toLocaleString("en")}`,
      413,
    );
  }

  const rows = unpacked.accepted.map((p) => {
    const id = randomUUID();
    return { id, fileName: p.fileName, originalPath: `imports/${importId}/photos/${id}${p.ext}`, bytes: p.bytes };
  });
  // The row is saved before the file: if we crash in between, processing finds no file and says so
  const added = rows.length
    ? await db
        .insert(photos)
        .values(rows.map((r) => ({ id: r.id, importId, fileName: r.fileName, originalPath: r.originalPath, status: "pending" as const })))
        .onConflictDoNothing({ target: [photos.importId, photos.fileName] })
        .returning({ id: photos.id })
    : [];
  const addedIds = new Set(added.map((r) => r.id));
  for (const row of rows) if (addedIds.has(row.id)) await saveFile(row.originalPath, row.bytes);

  if (unpacked.refused.length) {
    await db
      .insert(photos)
      .values(unpacked.refused.map((r) => ({ importId, fileName: r.fileName, status: "rejected" as const, reason: r.reason })))
      .onConflictDoNothing({ target: [photos.importId, photos.fileName] });
  }

  return {
    added: added.length,
    alreadyUploaded: rows.length - added.length,
    refused: unpacked.refused,
  };
}
