import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/server/env";

// Uploaded files live in a local folder for now. When we deploy, only this file changes
// (to Cloudflare R2, Supabase Storage, ...). Keys look like "imports/<id>/sheet.csv"

function resolveKey(key: string) {
  const root = path.resolve(env().STORAGE_DIR);
  const full = path.resolve(root, key);
  // Never let a key like "../../etc/passwd" escape the storage folder
  if (!full.startsWith(root + path.sep)) throw new Error(`Invalid storage key: ${key}`);
  return full;
}

export async function saveFile(key: string, data: Uint8Array): Promise<void> {
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
}

export async function readStoredFile(key: string): Promise<Buffer> {
  return readFile(resolveKey(key));
}

export async function deleteStoredFile(key: string): Promise<void> {
  await rm(resolveKey(key), { force: true });
}

// Deletes everything under a folder key, e.g. "imports/<id>"
export async function deleteStoredFolder(key: string): Promise<void> {
  await rm(resolveKey(key), { recursive: true, force: true });
}
