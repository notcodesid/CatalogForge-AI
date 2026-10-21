import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { importRows, imports } from "@/server/db/schema";
import { env } from "@/server/env";
import { saveFile } from "@/server/storage";
import { testDatabaseUrl } from "@/test/global-setup";
import { AttemptSuperseded, runParseImport, runStages, startAttempt } from "./run-parse-import";

const db = createDb(testDatabaseUrl());

beforeEach(async () => {
  await db.execute(sql`truncate imports, products restart identity cascade`);
});

afterAll(async () => {
  await db.$client.end();
  rmSync(env().STORAGE_DIR, { recursive: true, force: true });
});

// Same as an upload, minus the HTTP and queue parts
async function createTestImport(file: string, bytes: Uint8Array = readFileSync(file)) {
  const id = randomUUID();
  const sheetPath = `imports/${id}/${path.basename(file)}`;
  await saveFile(sheetPath, bytes);
  await db.insert(imports).values({ id, status: "queued", sheetFileName: path.basename(file), sheetPath });
  return id;
}

async function getImport(id: string) {
  const [imp] = await db.select().from(imports).where(eq(imports.id, id));
  return imp;
}

async function getRows(id: string) {
  return db.select().from(importRows).where(eq(importRows.importId, id)).orderBy(asc(importRows.rowNumber));
}

describe("runParseImport", () => {
  it("stores, cleans and groups every row of the sample sheet", async () => {
    const id = await createTestImport("samples/catalogforge_test_sheet.csv");
    await runParseImport(db, id);

    const imp = await getImport(id);
    expect(imp).toMatchObject({ status: "running", stage: "build", totalRows: 18 });
    expect(imp.parseInfo?.blankRows).toBe(1);

    const rows = await getRows(id);
    expect(rows).toHaveLength(18);
    // The sheet has a Parent SKU column, so rows without a parent are products of their own
    expect(new Set(rows.map((r) => r.productKey)).size).toBe(12);

    const byNumber = new Map(rows.map((r) => [r.rowNumber, r]));
    expect(byNumber.get(9)!.cleaned).toMatchObject({ priceCents: 129900, currency: "EUR", size: "150 × 45 × 85 cm" });
    expect(byNumber.get(8)!.cleaned).toMatchObject({ color: "green", colorSource: "Grün" });
    expect(byNumber.get(6)!.cleaned?.duplicateOfRow).toBe(2);
    expect(byNumber.get(3)!.reason).toBe("No price");
    expect(byNumber.get(4)!.reason).toContain("same SKU MG-01 but different price");
    expect(byNumber.get(13)!.cleaned?.descriptionHtml).toBe("<p>Glazed vase.</p>");
    expect(byNumber.get(2)!.reason).toBeNull();
  });

  it("gives the same result for the XLSX as for the CSV", async () => {
    const csv = await createTestImport("samples/catalogforge_test_sheet.csv");
    const xlsx = await createTestImport("samples/catalogforge_test_sheet.xlsx");
    await runParseImport(db, csv);
    await runParseImport(db, xlsx);

    const pick = (rows: Awaited<ReturnType<typeof getRows>>) =>
      rows.map((r) => ({ row: r.rowNumber, key: r.productKey, reason: r.reason, cleaned: r.cleaned }));
    expect(pick(await getRows(xlsx))).toEqual(pick(await getRows(csv)));
  });

  it("can run again after a crash without doubling rows or issues", async () => {
    const id = await createTestImport("samples/catalogforge_test_sheet.csv");
    await runParseImport(db, id);
    const before = await getRows(id);

    // Pretend the worker died right before it saved its progress: every stage runs a second time
    await db.update(imports).set({ stage: "parse" }).where(eq(imports.id, id));
    await runParseImport(db, id);

    const after = await getRows(id);
    expect(after).toHaveLength(18);
    expect(after.map((r) => r.cleaned)).toEqual(before.map((r) => r.cleaned));
    expect(after.map((r) => r.reason)).toEqual(before.map((r) => r.reason));
  });

  it("fails the import with a readable message when the file is broken", async () => {
    const id = await createTestImport("broken.csv", new TextEncoder().encode("%PDF-1.7 not a sheet"));
    await runParseImport(db, id);

    expect(await getImport(id)).toMatchObject({ status: "failed", error: expect.stringContaining("PDF") });
    expect(await getRows(id)).toHaveLength(0);
  });

  it("stops an old attempt from saving anything once a newer attempt has started", async () => {
    const id = await createTestImport("samples/catalogforge_test_sheet.csv");
    // Worker A starts, freezes, and worker B takes over
    const attemptA = (await startAttempt(db, id))!;
    const attemptB = (await startAttempt(db, id))!;
    expect(attemptB).toBe(attemptA + 1);

    // Worker A wakes up and tries to carry on
    await expect(runStages({ db, importId: id, attempt: attemptA })).rejects.toThrow(AttemptSuperseded);
    expect(await getRows(id)).toHaveLength(0);
    expect((await getImport(id)).stage).toBeNull();

    // Worker B's attempt is the one that counts
    await runStages({ db, importId: id, attempt: attemptB });
    expect(await getRows(id)).toHaveLength(18);
    expect((await getImport(id)).stage).toBe("build");
  });

  it("stops when pg-boss says the job is no longer ours", async () => {
    const id = await createTestImport("samples/catalogforge_test_sheet.csv");
    const attempt = (await startAttempt(db, id))!;
    const lost = new AbortController();
    lost.abort(new Error("job is no longer active under this worker's claim"));

    await expect(runStages({ db, importId: id, attempt, signal: lost.signal })).rejects.toThrow("no longer active");
    expect(await getRows(id)).toHaveLength(0);
  });

  it("doesn't restart an import that already failed or finished", async () => {
    const id = await createTestImport("samples/catalogforge_test_sheet.csv");
    await db.update(imports).set({ status: "failed", error: "gave up" }).where(eq(imports.id, id));

    expect(await startAttempt(db, id)).toBeNull();
    await runParseImport(db, id);
    expect(await getImport(id)).toMatchObject({ status: "failed", error: "gave up", attempt: 0 });
  });
});
