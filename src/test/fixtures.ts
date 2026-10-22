import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { countryLanguages, imports } from "@/server/db/schema";
import { saveFile } from "@/server/storage";

// Same as an upload, minus the HTTP and queue parts
export async function createTestImport(db: Db, file: string, bytes: Uint8Array = readFileSync(file)) {
  const id = randomUUID();
  const sheetPath = `imports/${id}/${path.basename(file)}`;
  await saveFile(sheetPath, bytes);
  await db.insert(imports).values({ id, status: "queued", sheetFileName: path.basename(file), sheetPath });
  return id;
}

// The shop's languages as when it's set up (Germany, Austria -> German, France -> French), or all switched off.
// Tests of other steps switch them off, so their imports don't wait for translations the test doesn't run
export async function setShopLanguages(db: Db, on: boolean) {
  await db.update(countryLanguages).set({ enabled: false });
  if (on) await db.update(countryLanguages).set({ enabled: true }).where(inArray(countryLanguages.country, ["DE", "AT", "FR"]));
}
