import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "@/test/global-setup";
import { createDb } from "./client";
import { importRows, imports, products, variants } from "./schema";

// These rules live in Postgres itself, so even buggy app code can't break them

const db = createDb(testDatabaseUrl());

beforeEach(async () => {
  await db.execute(sql`truncate imports, products restart identity cascade`);
});

afterAll(async () => {
  await db.$client.end();
});

// Drizzle wraps driver errors, the Postgres error code is on the cause
function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

async function expectPgError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected Postgres error ${code}`).toBeDefined();
  expect(pgErrorCode(err)).toBe(code);
}

async function createImport() {
  const [row] = await db.insert(imports).values({ sheetFileName: "supplier.csv" }).returning();
  return row;
}

async function createProduct() {
  const [row] = await db
    .insert(products)
    .values({ productKey: "tc-pl", handle: "terracotta-planter", title: "Terracotta Planter" })
    .returning();
  return row;
}

describe("import rows", () => {
  it("can't store the same sheet row twice (parser re-run after a restart)", async () => {
    const imp = await createImport();
    const row = { importId: imp.id, rowNumber: 14, raw: { SKU: "TC-PL-20" }, rowHash: "abc" };

    await db.insert(importRows).values(row).onConflictDoNothing();
    await db.insert(importRows).values(row).onConflictDoNothing();

    const rows = await db.select().from(importRows);
    expect(rows).toHaveLength(1);
  });
});

describe("variants", () => {
  it("rejects a second variant with the same SKU", async () => {
    const product = await createProduct();
    await db.insert(variants).values({ productId: product.id, sku: "TC-PL-20" });

    await expectPgError(db.insert(variants).values({ productId: product.id, sku: "TC-PL-20" }), "23505");
  });

  it("rejects a negative price", async () => {
    const product = await createProduct();

    await expectPgError(
      db.insert(variants).values({ productId: product.id, sku: "TC-PL-20", priceCents: -100, currency: "EUR" }),
      "23514",
    );
  });

  it("rejects a price without a currency", async () => {
    const product = await createProduct();

    await expectPgError(db.insert(variants).values({ productId: product.id, sku: "TC-PL-20", priceCents: 2499 }), "23514");
  });

  it("allows a missing price (the product goes to review instead)", async () => {
    const product = await createProduct();

    await db.insert(variants).values({ productId: product.id, sku: "TC-PL-30" });

    const [variant] = await db.select().from(variants);
    expect(variant.priceCents).toBeNull();
  });
});

describe("products", () => {
  it("can't have two products with the same product key (re-upload updates instead)", async () => {
    await createProduct();

    await expectPgError(createProduct(), "23505");
  });
});
