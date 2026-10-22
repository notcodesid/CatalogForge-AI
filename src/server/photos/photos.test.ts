import { readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockProvider, resetMockState } from "@/server/ai/mock";
import { createDb } from "@/server/db/client";
import { imports, photos, products } from "@/server/db/schema";
import { env } from "@/server/env";
import { addPhotos, createImport, startImport, UploadError } from "@/server/imports/create-import";
import { getImportSummary, productPhotos } from "@/server/imports/queries";
import { runBuildBatch } from "@/server/pipeline/build";
import { runParseImport } from "@/server/pipeline/run-parse-import";
import { queues, type BuildBatchJob, type ProcessPhotosJob } from "@/server/queue/queues";
import { startTestBoss } from "@/test/boss";
import { setShopLanguages } from "@/test/fixtures";
import { testDatabaseUrl } from "@/test/global-setup";
import { AssignPhotoError, assignPhoto } from "./assign";
import { downloadPhoto } from "./download";
import { planPhotoMatches, saveMatches } from "./match";
import { enqueuePhotoJobs, processPhotoBatch } from "./process";
import { MAX_PHOTOS_PER_IMPORT } from "./upload";

const db = createDb(testDatabaseUrl());
let boss: PgBoss;

// A small website on this machine that the sheets in these tests link to
let site = "";
const server = http.createServer((req, res) => {
  if (req.url === "/lamp.jpg") return res.writeHead(200, { "content-type": "image/jpeg" }).end(jpegForSite());
  if (req.url === "/page.html") return res.writeHead(200, { "content-type": "text/html" }).end("<html>a shop page</html>");
  res.writeHead(404).end();
});
const jpegForSite = () => readFileSync("samples/test-files/09-photos/photos/LMP-GR.jpg");
// Downloads in these tests may reach the test website (a private address); every call is counted
const downloads: string[] = [];
const download = (link: string) => {
  downloads.push(link);
  return downloadPhoto(link, { allowPrivateAddresses: true, retryDelaysMs: [] });
};

const SAMPLE = "samples/catalogforge_test_sheet.csv";
const PHOTO_DIR = "samples/test-files/09-photos/photos";
const testPhotos = readdirSync(PHOTO_DIR).map((name) => ({ name, bytes: readFileSync(`${PHOTO_DIR}/${name}`) }));
const jpeg = readFileSync(`${PHOTO_DIR}/TC-PL-20.jpg`);
const sheet = (fileName: string, bytes: Uint8Array = readFileSync(fileName)) => ({ fileName, bytes });

beforeAll(async () => {
  boss = await startTestBoss();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await db.execute(sql`truncate imports, products, ai_cache, ai_calls, ai_status restart identity cascade`);
  await boss.deleteAllJobs();
  delete process.env.MOCK_AI_MODE;
  resetMockState();
  // Translations are tested on their own (translations/translations.test.ts)
  await setShopLanguages(db, false);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await boss.stop();
  await db.$client.end();
  rmSync(env().STORAGE_DIR, { recursive: true, force: true });
});

async function photoJobs(importId: string) {
  return (await boss.findJobs<ProcessPhotosJob>(queues.processPhotos.name)).map((j) => j.data).filter((d) => d.importId === importId);
}

// What the worker does, without the queue: read the sheet, then the AI batches, then the photos (or photos first)
async function runImport(importId: string, order: "photos last" | "photos first" = "photos last") {
  const queued: BuildBatchJob[] = [];
  const process = async () => {
    for (const job of await photoJobs(importId)) await processPhotoBatch(db, job, { download });
  };
  if (order === "photos first") await process();
  await runParseImport(db, importId, {
    enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)),
    enqueuePhotos: async (tx, id, photoIds) => void (await enqueuePhotoJobs(tx, boss, id, photoIds)),
  });
  // Photos the sheet links to are queued while the sheet is read
  if (order === "photos first") await process();
  for (const job of queued) await runBuildBatch(db, mockProvider, job);
  if (order === "photos last") await process();
}

async function photoByName(importId: string) {
  const all = await db.select().from(photos).where(eq(photos.importId, importId));
  return new Map(all.map((p) => [p.fileName, p]));
}

describe("photos", () => {
  it("matches the test photos to the sample sheet's products, processes them, and finishes the import", async () => {
    const created = await createImport(db, boss, { ...sheet(SAMPLE), photos: [...testPhotos, { name: "notes.txt", bytes: Buffer.from("hello") }] });
    expect(created.import.status).toBe("queued");
    expect(created.photos).toMatchObject({ added: 21, refused: [{ fileName: "notes.txt", reason: "Not a photo. Use JPEG, PNG or WebP" }] });

    await runImport(created.import.id);
    const id = created.import.id;
    const byName = await photoByName(id);
    const status = (s: string) => [...byName.values()].filter((p) => p.status === s).map((p) => p.fileName).sort();
    expect(status("matched")).toEqual(["00123.jpg", "IMG_4532.jpg", "TC-PL-20.jpg", "TC-PL-30.jpg", "TC-PL-40.jpg", "UT-15.jpg", "UT-25.jpg", "tc-pl-30 (1).JPG"]);
    expect(status("rejected")).toEqual(["notes.txt"]);
    expect(byName.get("IMG_4533.jpg")).toMatchObject({ status: "unmatched", reason: expect.stringContaining("No product") });
    // The sheet's image column names IMG_4532.jpg for the hanging basket
    expect(byName.get("IMG_4532.jpg")).toMatchObject({ sku: "HB-PL-8", reason: "Row 10 names this file in column Image" });

    // Processed: resized copy and thumbnail, original upload gone, linked to the product and its variant
    const planterPhoto = byName.get("TC-PL-20.jpg")!;
    expect(planterPhoto).toMatchObject({ width: 800, height: 800, originalPath: null, storagePath: expect.stringMatching(/^photos\/[0-9a-f]{64}\.webp$/) });
    expect(planterPhoto.thumbnailPath).toBe(planterPhoto.storagePath!.replace(".webp", "-thumb.webp"));
    expect(planterPhoto.variantId).not.toBeNull();
    const [planter] = await db.select().from(products).where(eq(products.title, "Hand-thrown Terracotta Planter"));
    expect((await productPhotos(db, [planter.id])).map((p) => p.fileName)).toEqual(["TC-PL-20.jpg", "TC-PL-30.jpg", "tc-pl-30 (1).JPG", "TC-PL-40.jpg"]);

    const summary = await getImportSummary(db, id);
    expect(summary).toMatchObject({ status: "done", photos: { total: 22, matched: 8, unmatched: 13, rejected: 1, pending: 0, waitingToBeProcessed: 0 } });
    expect(summary!.photos.missing).toContainEqual({ file: "MG-01.jpg", rows: [4, 5] });
    expect(summary!.photos.missing.map((m) => m.file)).not.toContain("TC-PL-20.jpg");
  });

  it("waits for its photos, takes them in several requests, and starts only once", async () => {
    const created = await createImport(db, boss, { ...sheet(SAMPLE), waitForPhotos: true });
    const id = created.import.id;
    expect(created.import.status).toBe("waiting_for_files");
    expect(await boss.findJobs(queues.parseImport.name, { key: id })).toHaveLength(0);

    const zip = { name: "photos.zip", bytes: readFileSync("samples/test-files/09-photos/photos.zip") };
    expect(await addPhotos(db, id, [zip])).toMatchObject({ added: 21, alreadyUploaded: 0 });
    // The same request again (a retry): nothing new
    expect(await addPhotos(db, id, [zip])).toMatchObject({ added: 0, alreadyUploaded: 21 });

    expect((await startImport(db, boss, id)).status).toBe("queued");
    expect((await startImport(db, boss, id)).status).toBe("queued");
    expect(await boss.findJobs(queues.parseImport.name, { key: id })).toHaveLength(1);
    expect((await photoJobs(id)).flatMap((j) => j.photoIds)).toHaveLength(21);

    const late = await addPhotos(db, id, [testPhotos[0]]).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(UploadError);
    expect((late as UploadError).status).toBe(409);
  });

  it(`refuses more than ${MAX_PHOTOS_PER_IMPORT} photos before saving anything`, async () => {
    const tooMany = Array.from({ length: MAX_PHOTOS_PER_IMPORT + 1 }, (_, i) => ({ name: `p${i}.jpg`, bytes: jpeg }));
    const err = await createImport(db, boss, { ...sheet(SAMPLE), photos: tooMany }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).status).toBe(413);
    expect(await db.select().from(imports)).toEqual([]);
  });

  it("rejects a damaged photo, shows the same picture once, and only finishes once the photos are done", async () => {
    const csv = new TextEncoder().encode("SKU,Name,Price\nA-1,Blue Vase,10\n");
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("not really a photo")]);
    const created = await createImport(db, boss, {
      ...sheet("vases.csv", csv),
      photos: [
        { name: "A-1.jpg", bytes: jpeg },
        { name: "A-1 (2).jpg", bytes: jpeg },
        { name: "B-2.jpg", bytes: broken },
      ],
    });
    const id = created.import.id;

    // The products are written, but two photos still wait: not done yet
    const queued: BuildBatchJob[] = [];
    await runParseImport(db, id, { enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)) });
    for (const job of queued) await runBuildBatch(db, mockProvider, job);
    expect((await getImportSummary(db, id))!.status).toBe("running");

    const jobs = await photoJobs(id);
    for (const job of jobs) await processPhotoBatch(db, job);
    expect((await getImportSummary(db, id))!.status).toBe("done");

    const byName = await photoByName(id);
    expect(byName.get("B-2.jpg")).toMatchObject({ status: "rejected", reason: "This file can't be read as a photo. It may be damaged" });
    expect(byName.get("A-1 (2).jpg")!.storagePath).toBe(byName.get("A-1.jpg")!.storagePath);
    const [vase] = await db.select().from(products);
    expect(await productPhotos(db, [vase.id])).toHaveLength(1);

    // Running the batch again (a retry after a crash) changes nothing
    const before = byName.get("A-1.jpg")!.processedAt;
    for (const job of jobs) await processPhotoBatch(db, job);
    expect((await photoByName(id)).get("A-1.jpg")!.processedAt).toEqual(before);
  });

  it("lets the merchant put a photo on a product by hand, move it, take it off, and matching never undoes it", async () => {
    const created = await createImport(db, boss, { ...sheet(SAMPLE), photos: [...testPhotos, { name: "notes.txt", bytes: Buffer.from("hello") }] });
    const id = created.import.id;
    await runImport(id);
    const byName = await photoByName(id);
    const loose = byName.get("IMG_4533.jpg")!;
    const [planter] = await db.select().from(products).where(eq(products.title, "Hand-thrown Terracotta Planter"));
    const [basket] = await db.select().from(products).where(eq(products.title, "Hanging Basket Planter"));

    // By SKU, in any case: it goes on that variant, after the product's other photos
    expect(await assignPhoto(db, loose.id, { sku: "tc-pl-30" })).toMatchObject({ status: "matched", productId: planter.id, sku: "TC-PL-30" });
    expect((await productPhotos(db, [planter.id])).map((p) => p.fileName).at(-1)).toBe("IMG_4533.jpg");
    // Moved to a whole product instead
    expect(await assignPhoto(db, loose.id, { productId: basket.id })).toMatchObject({ productId: basket.id, sku: null });
    expect((await photoByName(id)).get("IMG_4533.jpg")).toMatchObject({ assignedByHand: true, reason: 'Put on "Hanging Basket Planter" by hand', variantId: null });

    // A wrongly matched photo taken off by hand stays off, even when matching runs again
    const wrong = byName.get("TC-PL-40.jpg")!;
    expect(await assignPhoto(db, wrong.id, { productId: null })).toMatchObject({ status: "unmatched", productId: null });
    await saveMatches(db, (await planPhotoMatches(db, id, "Image"))!.matches);
    expect((await photoByName(id)).get("TC-PL-40.jpg")).toMatchObject({ status: "unmatched", reason: "Taken off its product by hand" });
    expect((await photoByName(id)).get("IMG_4533.jpg")).toMatchObject({ status: "matched", productId: basket.id });

    // Clear refusals
    const refused = (photoId: string, target: Parameters<typeof assignPhoto>[2]) => assignPhoto(db, photoId, target).catch((e: AssignPhotoError) => [e.status, e.message]);
    expect(await refused(byName.get("notes.txt")!.id, { sku: "TC-PL-20" })).toEqual([409, "This photo was rejected (Not a photo. Use JPEG, PNG or WebP), so it can't be used"]);
    expect(await refused(loose.id, { sku: "NOPE-1" })).toEqual([404, 'No product has SKU "NOPE-1"']);
    await db.update(products).set({ deletedAt: new Date() }).where(eq(products.id, planter.id));
    expect(await refused(loose.id, { productId: planter.id })).toEqual([409, "That product was deleted. Restore it first"]);
  });

  it("downloads the photos a sheet links to, says why a link didn't work, and doesn't download a link twice", async () => {
    const csv = (extra = "") =>
      new TextEncoder().encode(
        `SKU,Name,Price,Image\nL-1,Ceramic Lamp,10,${site}/lamp.jpg\nL-2,Brass Lantern,12,${site}/missing.jpg\n` +
          `M-1,Mug,5,${site}/page.html\nV-1,Vase,9,https://cdn.example.com/files/V-1.jpg\n${extra}`,
      );
    // The vase's photo was uploaded too, so its link isn't downloaded
    const first = await createImport(db, boss, { ...sheet("links.csv", csv()), photos: [{ name: "V-1.jpg", bytes: jpeg }] });
    downloads.length = 0;
    await runImport(first.import.id);

    const byName = await photoByName(first.import.id);
    expect([...byName.keys()].sort()).toEqual([`${site}/lamp.jpg`, `${site}/missing.jpg`, `${site}/page.html`, "V-1.jpg"].sort());
    expect(byName.get(`${site}/lamp.jpg`)).toMatchObject({ status: "matched", sku: "L-1", sourceUrl: `${site}/lamp.jpg`, reason: "The link in row 2 in column Image", width: 800 });
    expect(byName.get(`${site}/missing.jpg`)).toMatchObject({ status: "rejected", reason: "Couldn't download the photo: The link answered 404 Not Found" });
    expect(byName.get(`${site}/page.html`)).toMatchObject({ status: "rejected", reason: "The link doesn't lead to a photo (JPEG, PNG or WebP)" });
    expect(byName.get("V-1.jpg")).toMatchObject({ status: "matched", reason: "Row 5 names this file in column Image" });
    expect(downloads).not.toContain("https://cdn.example.com/files/V-1.jpg");
    const [lamp] = await db.select().from(products).where(eq(products.title, "Ceramic Lamp"));
    expect((await productPhotos(db, [lamp.id])).map((p) => p.fileName)).toEqual([`${site}/lamp.jpg`]);
    expect((await getImportSummary(db, first.import.id))!).toMatchObject({ status: "done", photos: { matched: 2, rejected: 2, linksOverLimit: 0 } });

    // The same sheet again, with one more row: the lamp's photo is taken from the first download
    downloads.length = 0;
    const second = await createImport(db, boss, sheet("links.csv", csv("B-1,Bowl,7,\n")));
    await runImport(second.import.id);
    expect(downloads).not.toContain(`${site}/lamp.jpg`);
    expect((await photoByName(second.import.id)).get(`${site}/lamp.jpg`)).toMatchObject({ status: "matched", storagePath: byName.get(`${site}/lamp.jpg`)!.storagePath });
  });

  it("matches a photo to a product imported earlier when the new sheet doesn't have its SKU", async () => {
    await runImport((await createImport(db, boss, sheet(SAMPLE))).import.id);
    const csv = new TextEncoder().encode("SKU,Name,Price\nZ-9,Garden Gnome,15\n");
    const second = await createImport(db, boss, { ...sheet("gnomes.csv", csv), photos: [{ name: "UT-15.jpg", bytes: jpeg }] });
    await runImport(second.import.id, "photos first");

    const [photo] = await db.select().from(photos).where(eq(photos.importId, second.import.id));
    const [planter] = await db.select().from(products).where(eq(products.id, photo.productId!));
    expect(photo).toMatchObject({ status: "matched", sku: "UT-15", reason: "The file name is SKU UT-15, a product already in the catalog" });
    expect(planter.productKey).toContain("ut");
  });
});
