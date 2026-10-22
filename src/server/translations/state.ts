import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { Db } from "@/server/db/client";
import { products, translationState, variants } from "@/server/db/schema";
import { queues, type TranslateBatchJob } from "@/server/queue/queues";
import { englishFields, fieldHashes, isLocale, type Locale, sameHashes } from "./fields";
import { enabledLocales } from "./languages";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Products per translation call (one language at a time)
const TRANSLATE_BATCH_SIZE = 10;

// Called whenever a product's English may have changed: written by the AI, prices-only update (new variants
// can bring new colours), edited by the merchant. If what shoppers read changed, it's remembered and the
// product's translations are marked to do, for every language the shop shows. Unchanged English does nothing
export async function noteEnglishChange(tx: DbOrTx, productId: string) {
  const [product] = await tx
    .select({ title: products.title, descriptionHtml: products.descriptionHtml, tags: products.tags, attributes: products.attributes, englishHashes: products.englishHashes })
    .from(products)
    .where(eq(products.id, productId));
  if (!product) return;
  const productVariants = await tx.select({ options: variants.options }).from(variants).where(eq(variants.productId, productId));
  const hashes = fieldHashes(englishFields(product, productVariants));
  if (sameHashes(hashes, product.englishHashes)) return;

  await tx.update(products).set({ englishHashes: hashes }).where(eq(products.id, productId));
  await markPending(tx, [productId], await enabledLocales(tx));
}

// Marks translations to do. Taken off the queue too (queuedAt null): a job still running for the old English
// won't mark them done, and they're queued again for the new English
export async function markPending(tx: DbOrTx, productIds: string[], locales: Locale[]) {
  if (!productIds.length || !locales.length) return;
  for (let i = 0; i < productIds.length; i += 1000) {
    const values = productIds.slice(i, i + 1000).flatMap((productId) => locales.map((locale) => ({ productId, locale, status: "pending" as const })));
    await tx
      .insert(translationState)
      .values(values)
      .onConflictDoUpdate({
        target: [translationState.productId, translationState.locale],
        set: { status: "pending", error: null, queuedAt: null, updatedAt: new Date() },
      });
  }
}

// Queues the translations still to do, in batches per language. Each row is taken (queuedAt) in the same
// transaction that queues its job, so a product is never queued twice and never lost. Scope: one import's
// products, some products, or everything
export async function enqueuePendingTranslations(db: DbOrTx, boss: PgBoss, filter: { importId?: string; catalogOnly?: boolean; productIds?: string[] } = {}) {
  return db.transaction(async (tx) => {
    const conditions = [
      sql`p.id = ts.product_id`,
      sql`ts.status = 'pending'`,
      sql`ts.queued_at is null`,
      sql`p.deleted_at is null`,
      ...(filter.importId ? [sql`p.last_import_id = ${filter.importId}`] : []),
      ...(filter.catalogOnly ? [sql`p.last_import_id is null`] : []),
      ...(filter.productIds ? [filter.productIds.length ? sql`ts.product_id in (${sql.join(filter.productIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`] : []),
    ];
    const { rows } = await tx.execute<{ product_id: string; locale: string; last_import_id: string | null }>(sql`
      update ${translationState} ts set queued_at = now(), updated_at = now()
      from ${products} p
      where ${sql.join(conditions, sql` and `)}
      returning ts.product_id, ts.locale, p.last_import_id
    `);

    // One job per batch of products of the same import and language
    const groups = new Map<string, { importId: string | null; locale: Locale; productIds: string[] }>();
    for (const row of rows) {
      if (!isLocale(row.locale)) continue;
      const scope = row.last_import_id ?? "catalog";
      const key = `${scope}:${row.locale}`;
      const group = groups.get(key) ?? { importId: row.last_import_id, locale: row.locale, productIds: [] };
      group.productIds.push(row.product_id);
      groups.set(key, group);
    }
    const jobs = [];
    for (const group of groups.values()) {
      const ids = group.productIds.sort();
      for (let i = 0; i < ids.length; i += TRANSLATE_BATCH_SIZE) {
        const productIds = ids.slice(i, i + TRANSLATE_BATCH_SIZE);
        const scope = group.importId ?? "catalog";
        const hash = createHash("sha256").update(productIds.join("\n")).digest("hex").slice(0, 16);
        const data: TranslateBatchJob = { scope, importId: group.importId, locale: group.locale, productIds };
        jobs.push({ data, singletonKey: `translate:${scope}:${group.locale}:${hash}` });
      }
    }
    if (jobs.length) await boss.insert(queues.translateBatch.name, jobs, { db: fromDrizzle(tx, sql) });
    return jobs.length;
  });
}

// A translation job is finished with these products: done, unless their English changed meanwhile (then
// they're pending again and queued anew)
export async function markDone(db: DbOrTx, productId: string, locale: Locale, hashes: Record<string, string>) {
  await db.execute(sql`
    update ${translationState} ts set status = 'done', error = null, queued_at = null, updated_at = now()
    from ${products} p
    where ts.product_id = ${productId} and ts.locale = ${locale} and p.id = ts.product_id
      and p.english_hashes = ${JSON.stringify(hashes)}::jsonb and ts.queued_at is not null
  `);
}

export async function markFailed(db: DbOrTx, productIds: string[], locale: Locale, error: string) {
  if (!productIds.length) return;
  await db
    .update(translationState)
    .set({ status: "failed", error, queuedAt: null })
    .where(and(inArray(translationState.productId, productIds), eq(translationState.locale, locale), ne(translationState.status, "done")));
}

// The merchant asks to try failed translations again (all of them, or some products)
export async function retryFailed(db: DbOrTx, boss: PgBoss, filter: { productIds?: string[] } = {}) {
  await db
    .update(translationState)
    .set({ status: "pending", error: null, queuedAt: null })
    .where(and(eq(translationState.status, "failed"), filter.productIds ? inArray(translationState.productId, filter.productIds) : undefined));
  return enqueuePendingTranslations(db, boss, filter);
}

// A language was switched on: every product needs it. Products already translated (and unchanged) are found
// quickly by the job and cost no AI call
export async function backfillLocale(tx: DbOrTx, locale: Locale) {
  const all = await tx.select({ id: products.id }).from(products).where(isNull(products.deletedAt));
  await markPending(
    tx,
    all.map((p) => p.id),
    [locale],
  );
}

// A language was switched off: nothing left to do for it (what's done is kept for when it's switched on again)
export async function dropPending(tx: DbOrTx, locale: Locale) {
  await tx.delete(translationState).where(and(eq(translationState.locale, locale), eq(translationState.status, "pending")));
}
