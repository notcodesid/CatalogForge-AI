import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { imports } from "@/server/db/schema";
import { queues } from "@/server/queue/queues";
import { startTestBoss } from "@/test/boss";
import { testDatabaseUrl } from "@/test/global-setup";
import { MAX_RECOVERIES, recoverStalledImports } from "./watchdog";

const db = createDb(testDatabaseUrl());
let boss: PgBoss;

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
});

// An import that claims to be running, last touched 5 minutes ago
async function stalledImport(fields: Partial<typeof imports.$inferInsert> = {}) {
  const id = randomUUID();
  await db.insert(imports).values({ id, sheetFileName: "sheet.csv", status: "running", stage: "clean", ...fields });
  await db.execute(sql`update imports set updated_at = now() - interval '5 minutes' where id = ${id}`);
  return id;
}

async function getImport(id: string) {
  const [row] = await db.select().from(imports).where(eq(imports.id, id));
  return row;
}

describe("recoverStalledImports", () => {
  it("restarts a running import whose job has gone missing", async () => {
    const id = await stalledImport();

    const result = await recoverStalledImports(db, boss);

    expect(result.restarted).toEqual([id]);
    expect(await getImport(id)).toMatchObject({ status: "queued", recoveries: 1 });
    expect(await boss.findJobs(queues.parseImport.name, { key: id })).toHaveLength(1);
  });

  it(`gives up after ${MAX_RECOVERIES} restarts and fails the import with a message`, async () => {
    const id = await stalledImport({ recoveries: MAX_RECOVERIES });

    const result = await recoverStalledImports(db, boss);

    expect(result.failed).toEqual([id]);
    expect(await getImport(id)).toMatchObject({ status: "failed", error: expect.stringContaining("stopped unexpectedly") });
  });

  it("leaves an import alone while its job is waiting or running", async () => {
    const id = await stalledImport();
    await boss.send(queues.parseImport.name, { importId: id }, { singletonKey: id });

    expect(await recoverStalledImports(db, boss)).toEqual({ restarted: [], failed: [] });
  });

  it("leaves recently changed imports alone (they're probably between two steps)", async () => {
    const id = randomUUID();
    await db.insert(imports).values({ id, sheetFileName: "sheet.csv", status: "running", stage: "clean" });

    expect(await recoverStalledImports(db, boss)).toEqual({ restarted: [], failed: [] });
  });

  it("leaves imports waiting for the AI step alone", async () => {
    await stalledImport({ stage: "build" });

    expect(await recoverStalledImports(db, boss)).toEqual({ restarted: [], failed: [] });
  });
});
