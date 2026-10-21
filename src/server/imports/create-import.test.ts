import { readFileSync, rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { imports } from "@/server/db/schema";
import { env } from "@/server/env";
import { queues } from "@/server/queue/queues";
import { startTestBoss } from "@/test/boss";
import { testDatabaseUrl } from "@/test/global-setup";
import { createImport, UploadError } from "./create-import";

const db = createDb(testDatabaseUrl());
let boss: PgBoss;
const sheet = new Uint8Array(readFileSync("samples/catalogforge_test_sheet.csv"));

beforeAll(async () => {
  boss = await startTestBoss();
});

beforeEach(async () => {
  await db.execute(sql`truncate imports, products restart identity cascade`);
  await boss.deleteAllJobs();
});

afterAll(async () => {
  await boss.stop();
  await db.$client.end();
  rmSync(env().STORAGE_DIR, { recursive: true, force: true });
});

describe("createImport", () => {
  it("saves the import and its job together", async () => {
    const result = await createImport(db, boss, { fileName: "sheet.csv", bytes: sheet });

    expect(result.alreadyRunning).toBe(false);
    const jobs = await boss.findJobs(queues.parseImport.name, { key: result.import.id });
    expect(jobs).toHaveLength(1);
  });

  it("turns 5 uploads of the same file at the same moment into one import", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createImport(db, boss, { fileName: "sheet.csv", bytes: sheet })),
    );

    expect(new Set(results.map((r) => r.import.id)).size).toBe(1);
    expect(results.filter((r) => !r.alreadyRunning)).toHaveLength(1);
    expect(await db.select().from(imports)).toHaveLength(1);
    expect(await boss.findJobs(queues.parseImport.name)).toHaveLength(1);
  });

  it("allows the same file again once the first import has finished", async () => {
    const first = await createImport(db, boss, { fileName: "sheet.csv", bytes: sheet });
    await db.execute(sql`update imports set status = 'failed' where id = ${first.import.id}`);

    const second = await createImport(db, boss, { fileName: "sheet.csv", bytes: sheet });
    expect(second.alreadyRunning).toBe(false);
    expect(second.import.id).not.toBe(first.import.id);
  });

  it("refuses files that aren't spreadsheets", async () => {
    await expect(createImport(db, boss, { fileName: "x.csv", bytes: new TextEncoder().encode("%PDF-1.7") })).rejects.toThrow(UploadError);
    await expect(createImport(db, boss, { fileName: "x.csv", bytes: new Uint8Array() })).rejects.toThrow("The file is empty");
  });
});

describe("parse-import queue", () => {
  it("refuses a second job for an import that already has one waiting or running", async () => {
    const { import: imp } = await createImport(db, boss, { fileName: "sheet.csv", bytes: sheet });

    const second = await boss.send(queues.parseImport.name, { importId: imp.id }, { singletonKey: imp.id });
    expect(second).toBeNull();
  });

  it("sends a job that failed all its tries to the dead-letter queue", async () => {
    const { import: imp } = await createImport(db, boss, { fileName: "sheet.csv", bytes: sheet });
    // Use up every try at once by failing the job with no retries left
    await db.execute(sql`update pgboss.job set retry_limit = 0 where singleton_key = ${imp.id}`);
    const [job] = await boss.fetch(queues.parseImport.name);
    await boss.fail(queues.parseImport.name, job.id, { message: "boom" });

    const dead = await boss.findJobs(queues.parseImportDead.name);
    expect(dead.map((j) => j.data)).toEqual([{ importId: imp.id }]);
  });
});
