import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { storedFiles } from "@/server/db/schema";
import { env, type Env } from "@/server/env";

// Uploaded files: sheets, photos as uploaded, and resized photos. Keys look like "imports/<id>/sheet.csv".
// The web app saves uploads and serves photos, and the worker reads sheets and resizes photos, so both need the
// same files. Locally (and in tests) that's a folder. When they run on different machines, it's an S3-compatible
// bucket such as Cloudflare R2 (set S3_BUCKET), or for a small demo the database itself (FILE_STORAGE=database)

type Storage = {
  save(key: string, data: Uint8Array): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  // Everything under a folder key, e.g. "imports/<id>"
  removeFolder(key: string): Promise<void>;
};

// Never let a key like "../../etc/passwd" reach outside the storage folder or the bucket's folders
function checkKey(key: string) {
  if (!key || key.startsWith("/") || key.includes("\\") || key.split("/").includes("..")) throw new Error(`Invalid storage key: ${key}`);
  return key;
}

function folderStorage(dir: string): Storage {
  const root = path.resolve(dir);
  const resolve = (key: string) => {
    const full = path.resolve(root, checkKey(key));
    if (!full.startsWith(root + path.sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  };
  return {
    async save(key, data) {
      const full = resolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, data);
    },
    read: (key) => readFile(resolve(key)),
    remove: (key) => rm(resolve(key), { force: true }),
    removeFolder: (key) => rm(resolve(key), { recursive: true, force: true }),
  };
}

function bucketStorage(config: Env): Storage {
  const client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
    // "endpoint/bucket/key" rather than "bucket.endpoint/key": R2, MinIO and local test servers all take it
    forcePathStyle: true,
    // Newer SDK versions send checksum headers on every request, which R2 doesn't all accept. Only when required
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const Bucket = config.S3_BUCKET!;
  const remove = async (Key: string) => void (await client.send(new DeleteObjectCommand({ Bucket, Key })));
  return {
    async save(key, data) {
      await client.send(new PutObjectCommand({ Bucket, Key: checkKey(key), Body: data }));
    },
    async read(key) {
      const { Body } = await client.send(new GetObjectCommand({ Bucket, Key: checkKey(key) }));
      if (!Body) throw new Error(`Empty file: ${key}`);
      return Buffer.from(await Body.transformToByteArray());
    },
    remove: (key) => remove(checkKey(key)),
    async removeFolder(key) {
      const Prefix = `${checkKey(key)}/`;
      let ContinuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        // One request per file, 20 at a time: the many-at-once delete needs a checksum header R2 may refuse
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : []));
        for (let i = 0; i < keys.length; i += 20) await Promise.all(keys.slice(i, i + 20).map(remove));
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
    },
  };
}

// The files in a table (stored_files). Only for small demo deployments: every photo is read through the database
function databaseStorage(): Storage {
  return {
    async save(key, data) {
      const values = { key: checkKey(key), data: Buffer.from(data) };
      await getDb().insert(storedFiles).values(values).onConflictDoUpdate({ target: storedFiles.key, set: { data: values.data } });
    },
    async read(key) {
      const [file] = await getDb().select({ data: storedFiles.data }).from(storedFiles).where(eq(storedFiles.key, checkKey(key)));
      if (!file) throw new Error(`No such file: ${key}`);
      return file.data;
    },
    async remove(key) {
      await getDb().delete(storedFiles).where(eq(storedFiles.key, checkKey(key)));
    },
    async removeFolder(key) {
      await getDb().delete(storedFiles).where(sql`starts_with(${storedFiles.key}, ${`${checkKey(key)}/`})`);
    },
  };
}

let storage: Storage | undefined;
const store = () =>
  (storage ??= env().S3_BUCKET ? bucketStorage(env()) : env().FILE_STORAGE === "database" ? databaseStorage() : folderStorage(env().STORAGE_DIR));

export async function saveFile(key: string, data: Uint8Array): Promise<void> {
  await store().save(key, data);
}

export async function readStoredFile(key: string): Promise<Buffer> {
  return store().read(key);
}

export async function deleteStoredFile(key: string): Promise<void> {
  await store().remove(key);
}

// Deletes everything under a folder key, e.g. "imports/<id>"
export async function deleteStoredFolder(key: string): Promise<void> {
  await store().removeFolder(key);
}
