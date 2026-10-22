import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import { fileKind, MAX_PHOTO_BYTES, unpackPhotos } from "./upload";

const PHOTOS = "samples/test-files/09-photos";
const jpeg = readFileSync(`${PHOTOS}/photos/TC-PL-20.jpg`);
const png = readFileSync(`${PHOTOS}/photos/DSC00871.png`);

function zipOf(entries: [string, Buffer][]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of entries) zip.addBuffer(bytes, name);
  zip.end();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

describe("fileKind", () => {
  it("goes by the file's bytes, not its name", () => {
    expect(fileKind(jpeg)).toBe("jpeg");
    expect(fileKind(png)).toBe("png");
    expect(fileKind(Buffer.from("%PDF-1.7 a price list"))).toBeNull();
    expect(fileKind(Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypheic")]))).toBe("heic");
  });
});

describe("unpackPhotos", () => {
  it("reads every photo in a real ZIP", async () => {
    const { accepted, refused } = await unpackPhotos([{ name: "photos.zip", bytes: readFileSync(`${PHOTOS}/photos.zip`) }]);
    expect(accepted).toHaveLength(21);
    expect(accepted.map((p) => p.fileName)).toContain("tc-pl-30 (1).JPG");
    expect(refused).toEqual([]);
  });

  it("skips files computers add, and refuses what isn't a photo, with the reason", async () => {
    const zip = await zipOf([
      ["planters/TC-PL-20.jpg", jpeg],
      ["__MACOSX/planters/._TC-PL-20.jpg", Buffer.from("resource fork")],
      ["planters/.DS_Store", Buffer.from("folder settings")],
      ["planters/notes.txt", Buffer.from("not a photo")],
      ["more.zip", await zipOf([["a.jpg", jpeg]])],
    ]);
    const { accepted, refused } = await unpackPhotos([
      { name: "upload.zip", bytes: zip },
      { name: "DSC00871.png", bytes: png },
      { name: "IMG_0001.HEIC", bytes: Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypheic")]) },
      { name: "huge.jpg", bytes: Buffer.concat([jpeg, Buffer.alloc(MAX_PHOTO_BYTES)]) },
    ]);
    expect(accepted.map((p) => p.fileName)).toEqual(["planters/TC-PL-20.jpg", "DSC00871.png"]);
    expect(refused).toEqual([
      { fileName: "planters/notes.txt", reason: "Not a photo. Use JPEG, PNG or WebP" },
      { fileName: "more.zip", reason: "A ZIP inside a ZIP isn't supported. Unpack it first" },
      { fileName: "IMG_0001.HEIC", reason: "HEIC photos (from iPhones) aren't supported. Export them as JPEG" },
      { fileName: "huge.jpg", reason: "Too big (20 MB). The limit is 20 MB per photo" },
    ]);
  });

  it("refuses a damaged ZIP instead of failing the whole upload", async () => {
    const { accepted, refused } = await unpackPhotos([{ name: "broken.zip", bytes: Buffer.from("PK\u0003\u0004 not really a zip") }]);
    expect(accepted).toEqual([]);
    expect(refused).toEqual([{ fileName: "broken.zip", reason: "This ZIP can't be opened. It may be damaged" }]);
  });
});
