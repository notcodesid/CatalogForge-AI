import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { findMentions } from "@/server/ai/claims";
import { isCategory } from "@/server/ai/taxonomy";
import type { Db } from "@/server/db/client";
import { products, translationState, variants } from "@/server/db/schema";
import { cleanDescription } from "@/server/pipeline/clean/html";
import { cleanText } from "@/server/pipeline/clean/text";
import { enqueuePendingTranslations, noteEnglishChange } from "@/server/translations/state";
import { type ProductDetail, productDetail, splitReasons } from "./detail";

// A request the merchant can fix (unknown product, a category that isn't in the list...). Shown as is
export class ProductActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// The merchant's own note when sending a product back. It's kept with the listing's problems, so it survives a
// prices-only re-upload, and goes away when the product is approved (or the AI writes a new listing)
const SENT_BACK = "Sent back: ";

// Colour, size, price, SKU and weight belong to each variant, not to the product (same rule as for the AI)
const VARIANT_FACTS = new Set(["color", "colour", "size", "price", "sku", "weight"]);

// What the merchant can change by hand. Unknown fields are refused rather than silently ignored
export const productEdit = z
  .strictObject({
    title: z.string().max(200).optional(),
    descriptionHtml: z.string().max(50_000).optional(),
    category: z.string().max(300).nullable().optional(),
    tags: z.array(z.string().max(100)).max(30).optional(),
    attributes: z.record(z.string().max(100), z.string().max(1000)).optional(),
  })
  .refine((edit) => Object.values(edit).some((v) => v !== undefined), "Send at least one field to change: title, descriptionHtml, category, tags or attributes");
export type ProductEdit = z.infer<typeof productEdit>;

// The product as the review screen shows it, after an action (it exists: the action just found it)
async function detailOf(db: Db, id: string): Promise<ProductDetail> {
  const detail = await productDetail(db, id);
  if (!detail) throw new ProductActionError("Product not found", 404);
  return detail;
}

async function lockProduct(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], id: string) {
  const [product] = await tx.select().from(products).where(eq(products.id, id)).for("update");
  if (!product) throw new ProductActionError("Product not found", 404);
  if (product.deletedAt) throw new ProductActionError("This product is deleted. Restore it first", 409);
  return product;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// Risky claims ("organic", "frost-proof"...) the merchant's new text makes but the supplier's text doesn't.
// The merchant can still save it (it's their shop), but they're told
function claimWarnings(sourceText: string | null, fields: { field: string; text: string }[]): string[] {
  if (sourceText === null) return [];
  const supplier = new Set(findMentions(sourceText).filter((m) => !m.negated).map((m) => m.concept.id));
  const warnings: string[] = [];
  for (const { field, text } of fields) {
    const extra = findMentions(text).filter((m) => !m.negated && !supplier.has(m.concept.id));
    for (const phrase of new Set(extra.map((m) => m.phrase))) warnings.push(`The ${field} says "${phrase}", but the supplier's text never does`);
  }
  return warnings;
}

// The merchant edits the English. Each changed field is marked as theirs (the AI never overwrites it on a
// re-upload), counts as certain (confidence 100), and only the changed fields are translated again. The status
// doesn't change: editing isn't approving
export async function editProduct(db: Db, boss: PgBoss, id: string, edit: ProductEdit) {
  const result = await db.transaction(async (tx) => {
    const product = await lockProduct(tx, id);
    const next: Partial<Pick<typeof products.$inferInsert, "title" | "descriptionHtml" | "category" | "tags" | "attributes">> = {};

    if (edit.title !== undefined) {
      const title = cleanText(edit.title);
      if (!title) throw new ProductActionError("The title can't be empty");
      if (title !== product.title) next.title = title;
    }
    if (edit.descriptionHtml !== undefined) {
      // Same cleaning as supplier HTML: no scripts, no attributes, only basic formatting
      const html = cleanDescription(edit.descriptionHtml)?.html ?? "";
      if (html !== product.descriptionHtml) next.descriptionHtml = html;
    }
    if (edit.category !== undefined) {
      const category = edit.category?.trim() || null;
      if (category && !isCategory(category)) throw new ProductActionError(`"${category}" isn't in the category list`);
      if (category !== product.category) next.category = category;
    }
    if (edit.tags !== undefined) {
      const tags = [...new Set(edit.tags.map((t) => cleanText(t)?.toLowerCase()).filter((t): t is string => Boolean(t)))];
      if (tags.some((t) => t.length > 40)) throw new ProductActionError("A tag can be at most 40 characters");
      if (!sameList(tags, product.tags)) next.tags = tags;
    }
    if (edit.attributes !== undefined) {
      const attributes: Record<string, string> = {};
      for (const [name, value] of Object.entries(edit.attributes)) {
        const key = cleanText(name)?.toLowerCase();
        const text = cleanText(value);
        if (!key || !text) continue;
        if (VARIANT_FACTS.has(key)) throw new ProductActionError(`"${key}" is set per variant, not as an attribute`);
        attributes[key] = text;
      }
      if (JSON.stringify(Object.entries(attributes).sort()) !== JSON.stringify(Object.entries(product.attributes).sort())) next.attributes = attributes;
    }

    const changed = Object.keys(next) as (keyof typeof next)[];
    if (!changed.length) return { changed, warnings: [] as string[] };

    // What the merchant wrote is certain. Confidence keys follow the AI's names ("description", "attributes.care")
    const confidence = { ...product.confidence };
    for (const field of changed) {
      if (field === "attributes") {
        for (const key of Object.keys(confidence)) if (key.startsWith("attributes.")) delete confidence[key];
        for (const key of Object.keys(next.attributes!)) confidence[`attributes.${key}`] = 100;
      } else {
        confidence[field === "descriptionHtml" ? "description" : field] = 100;
      }
    }
    await tx
      .update(products)
      .set({ ...next, confidence, merchantEditedFields: [...new Set([...product.merchantEditedFields, ...changed])] })
      .where(eq(products.id, id));
    // Only fields whose English really changed get translated again
    await noteEnglishChange(tx, id);

    const sourceText = product.sourceInput ? product.sourceInput.sourceRows.flatMap((r) => Object.values(r.cells)).join(". ") : null;
    const warnings = claimWarnings(sourceText, [
      ...(next.title ? [{ field: "title", text: next.title }] : []),
      ...(next.descriptionHtml !== undefined ? [{ field: "description", text: cleanDescription(next.descriptionHtml)?.text ?? "" }] : []),
    ]);
    return { changed, warnings };
  });

  if (result.changed.length) await enqueuePendingTranslations(db, boss, { productIds: [id] });
  return { ...result, product: await detailOf(db, id) };
}

// Approving puts a product in the storefront. Refused when a variant has no price: a shopper can't buy it, and we
// never make a price up. The merchant's "sent back" note goes away; the other review reasons stay as history
const approvable = sql`${products.deletedAt} is null
  and exists (select 1 from ${variants} v where v.product_id = ${products.id})
  and not exists (select 1 from ${variants} v where v.product_id = ${products.id} and v.price_cents is null)`;

async function approveWhere(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], ids: string[]) {
  if (!ids.length) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    update ${products} set
      status = 'approved', approved_at = now(), updated_at = now(),
      content_review_reasons = array(select r from unnest(content_review_reasons) as r where r not like ${`${SENT_BACK}%`}),
      review_reason = nullif(array_to_string(array(
        select r from unnest(string_to_array(review_reason, '; ')) as r where r not like ${`${SENT_BACK}%`}
      ), '; '), '')
    where ${products.id} in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) and status <> 'approved' and ${approvable}
    returning id
  `);
  return rows.map((r) => r.id);
}

type Blocker = { title: string | null; status: (typeof products.$inferSelect)["status"] | null; reason: string | null };

// Why each product can't be approved (reason null: it can)
async function blockers(db: Db, ids: string[]): Promise<Map<string, Blocker>> {
  const found = ids.length
    ? await db.select({ id: products.id, title: products.title, status: products.status, deletedAt: products.deletedAt }).from(products).where(inArray(products.id, ids))
    : [];
  const skus = ids.length
    ? await db.select({ productId: variants.productId, sku: variants.sku, priceCents: variants.priceCents }).from(variants).where(inArray(variants.productId, ids))
    : [];
  return new Map(
    ids.map((id): [string, Blocker] => {
      const product = found.find((p) => p.id === id);
      if (!product) return [id, { title: null, status: null, reason: "Product not found" }];
      const mine = skus.filter((v) => v.productId === id);
      const unpriced = mine.filter((v) => v.priceCents === null).map((v) => v.sku).sort();
      const reason = product.deletedAt
        ? "This product is deleted. Restore it first"
        : !mine.length
          ? "This product has no variants, so there's nothing to sell"
          : unpriced.length
            ? `SKU ${unpriced.join(", ")} ${unpriced.length > 1 ? "have" : "has"} no price. Add the price in the sheet and upload it again, then approve`
            : null;
      return [id, { title: product.title, status: product.status, reason }];
    }),
  );
}

export async function approveProduct(db: Db, id: string) {
  const blocked = (await blockers(db, [id])).get(id)!;
  if (blocked.reason) throw new ProductActionError(blocked.reason, blocked.status ? 409 : 404);
  const approved = await approveWhere(db, [id]);
  return { id, alreadyApproved: !approved.length && blocked.status === "approved", product: await detailOf(db, id) };
}

// Approves many at once: the products picked by the merchant, or every "ready" product of an import (the ones that
// passed every check). Products that can't be approved are listed with the reason; the rest are approved
export async function bulkApprove(db: Db, target: { ids: string[] } | { importId: string }) {
  const ids =
    "ids" in target
      ? [...new Set(target.ids)]
      : (
          await db
            .select({ id: products.id })
            .from(products)
            .where(and(eq(products.lastImportId, target.importId), eq(products.status, "ready"), isNull(products.deletedAt)))
        ).map((p) => p.id);
  const checked = await blockers(db, ids);
  const approved = await approveWhere(
    db,
    ids.filter((id) => !checked.get(id)!.reason),
  );
  const skipped = ids.filter((id) => checked.get(id)!.reason).map((id) => ({ id, title: checked.get(id)!.title, reason: checked.get(id)!.reason! }));
  return { approved: approved.length, alreadyApproved: ids.filter((id) => !checked.get(id)!.reason && !approved.includes(id)).length, skipped };
}

// The merchant sends a product back to review, with why. It leaves the storefront until it's approved again
export async function sendBack(db: Db, id: string, reason: string) {
  const note = `${SENT_BACK}${reason.replace(/\s*;\s*/g, ", ").trim()}`;
  await db.transaction(async (tx) => {
    const product = await lockProduct(tx, id);
    const content = [note, ...product.contentReviewReasons.filter((r) => !r.startsWith(SENT_BACK))];
    const others = splitReasons(product.reviewReason).filter((r) => !r.startsWith(SENT_BACK));
    await tx
      .update(products)
      .set({ status: "needs_review", approvedAt: null, contentReviewReasons: content, reviewReason: [note, ...others].join("; ") })
      .where(eq(products.id, id));
  });
  return { id, product: await detailOf(db, id) };
}

// Soft delete: gone from the storefront and exports at once, but kept, so a re-upload doesn't bring it back
// silently and the merchant can restore it
export async function deleteProduct(db: Db, id: string) {
  const [product] = await db.select({ deletedAt: products.deletedAt }).from(products).where(eq(products.id, id));
  if (!product) throw new ProductActionError("Product not found", 404);
  if (product.deletedAt) return { id, deletedAt: product.deletedAt, alreadyDeleted: true };
  const [row] = await db.update(products).set({ deletedAt: new Date() }).where(eq(products.id, id)).returning({ deletedAt: products.deletedAt });
  return { id, deletedAt: row.deletedAt, alreadyDeleted: false };
}

// Brings a deleted product back, with the status it had. Translations that were waiting while it was deleted are
// queued again
export async function restoreProduct(db: Db, boss: PgBoss, id: string) {
  const [product] = await db.select({ deletedAt: products.deletedAt }).from(products).where(eq(products.id, id));
  if (!product) throw new ProductActionError("Product not found", 404);
  if (product.deletedAt) {
    await db.update(products).set({ deletedAt: null }).where(eq(products.id, id));
    await db.update(translationState).set({ queuedAt: null }).where(and(eq(translationState.productId, id), eq(translationState.status, "pending")));
    await enqueuePendingTranslations(db, boss, { productIds: [id] });
  }
  return { id, restored: Boolean(product.deletedAt), product: await detailOf(db, id) };
}
