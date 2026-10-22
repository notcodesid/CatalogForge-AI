import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { findMentions } from "@/server/ai/claims";
import { type OptionNames, renameOptions } from "@/server/ai/option-names";
import { isCategory } from "@/server/ai/taxonomy";
import type { Db } from "@/server/db/client";
import { importRows, imports, products, translationState, variants } from "@/server/db/schema";
import { rowReasons, sheetPriceNoteStart } from "@/server/pipeline/build";
import { cleanDescription } from "@/server/pipeline/clean/html";
import { skuKey } from "@/server/pipeline/clean/row";
import { cleanText } from "@/server/pipeline/clean/text";
import { enqueuePendingTranslations, noteEnglishChange } from "@/server/translations/state";
import { newVersionOf, priceCurrency, type ProductDetail, productDetail, splitReasons } from "./detail";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Product = typeof products.$inferSelect;

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
    // New prices by SKU, as typed: "21.50" or "21,50". Text, not JSON numbers: a price is never a float
    prices: z.record(z.string().max(100), z.string().max(30)).optional(),
  })
  .refine(
    (edit) => Object.values(edit).some((v) => v !== undefined),
    "Send at least one field to change: title, descriptionHtml, category, tags, attributes or prices",
  );
export type ProductEdit = z.infer<typeof productEdit>;

// The most a typed price can be. More is surely a typo
const MAX_PRICE_CENTS = 1_000_000_00;

// A price as the merchant types it ("21.50" or "21,50") in cents. Integer maths on the digits, never floats. Zero is
// fine (a free sample), more than 2 decimals isn't
export function typedPriceCents(sku: string, text: string): number {
  const value = text.trim();
  if (!value) throw new ProductActionError(`Enter a price for SKU ${sku}, like 21.50`);
  if (value.startsWith("-")) throw new ProductActionError(`The price of SKU ${sku} can't be negative`);
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(value);
  if (!match) throw new ProductActionError(`The price of SKU ${sku} should be a number, like 21.50`);
  const [, whole, fraction = ""] = match;
  if (fraction.length > 2) throw new ProductActionError(`The price of SKU ${sku} can have at most 2 decimals`);
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (cents > MAX_PRICE_CENTS) throw new ProductActionError(`The price of SKU ${sku} can be at most 1,000,000`);
  return cents;
}

// The product as the review screen shows it, after an action (it exists: the action just found it)
async function detailOf(db: Db, id: string): Promise<ProductDetail> {
  const detail = await productDetail(db, id);
  if (!detail) throw new ProductActionError("Product not found", 404);
  return detail;
}

async function lockProduct(tx: Tx, id: string) {
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

// Saves the prices the merchant typed (by SKU), each in its variant's currency (see priceCurrency) and marked as
// theirs: a re-upload of the sheet never changes it. The review reasons a new price solves go away: the sheet's
// price problems for that SKU ("Row 9: No price", two rows with different prices), "still has no price" and "the
// supplier's sheet now says...". Returns the SKUs whose price changed and the product's review reason without the
// solved ones
async function savePrices(tx: Tx, product: Product, typed: Record<string, string>) {
  const mine = await tx.select().from(variants).where(eq(variants.productId, product.id));
  const [imp] = product.lastImportId
    ? await tx.select({ defaultCurrency: imports.defaultCurrency }).from(imports).where(eq(imports.id, product.lastImportId))
    : [];
  const changed: string[] = [];
  for (const [sku, text] of Object.entries(typed)) {
    const variant = mine.find((v) => v.sku === sku);
    if (!variant) throw new ProductActionError(`SKU ${sku} isn't a variant of this product`);
    const priceCents = typedPriceCents(sku, text);
    const currency = priceCurrency(variant, mine, imp?.defaultCurrency);
    if (priceCents === variant.priceCents && currency === variant.currency) continue;
    await tx.update(variants).set({ priceCents, currency, priceSetByHand: true }).where(eq(variants.id, variant.id));
    changed.push(sku);
  }
  if (!changed.length) return { changed, reviewReason: product.reviewReason };

  // The reasons the sheet's rows give with the earlier hand-set prices, minus the ones they still give now
  const rows =
    product.lastImportId && product.sourceRows.length
      ? await tx
          .select({ rowNumber: importRows.rowNumber, cleaned: importRows.cleaned })
          .from(importRows)
          .where(and(eq(importRows.importId, product.lastImportId), inArray(importRows.rowNumber, product.sourceRows)))
      : [];
  const sheetRows = rows.flatMap((r) => (r.cleaned ? [{ rowNumber: r.rowNumber, cleaned: r.cleaned }] : []));
  const before = new Set(mine.filter((v) => v.priceSetByHand).map((v) => skuKey(v.sku)));
  const left = new Set(rowReasons(sheetRows, product.productKey, new Set([...before, ...changed.map(skuKey)])));
  const solved = new Set([
    ...rowReasons(sheetRows, product.productKey, before).filter((r) => !left.has(r)),
    ...changed.map((sku) => `SKU ${sku} still has no price (from an earlier upload)`),
  ]);
  const answered = (reason: string) => changed.some((sku) => reason.startsWith(sheetPriceNoteStart(sku)));
  return { changed, reviewReason: splitReasons(product.reviewReason).filter((r) => !solved.has(r) && !answered(r)).join("; ") || null };
}

// The merchant edits the English. Each changed field is marked as theirs (the AI never overwrites it on a
// re-upload), counts as certain (confidence 100), and only the changed fields are translated again. Prices they
// type are theirs too (see savePrices). The status doesn't change: editing isn't approving
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
    const prices = edit.prices ? await savePrices(tx, product, edit.prices) : { changed: [], reviewReason: product.reviewReason };
    if (!changed.length && !prices.changed.length) return { changed: [] as string[], warnings: [] as string[] };

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
      .set({ ...next, confidence, merchantEditedFields: [...new Set([...product.merchantEditedFields, ...changed])], reviewReason: prices.reviewReason })
      .where(eq(products.id, id));
    // Only fields whose English really changed get translated again
    await noteEnglishChange(tx, id);

    const sourceText = product.sourceInput ? product.sourceInput.sourceRows.flatMap((r) => Object.values(r.cells)).join(". ") : null;
    const warnings = claimWarnings(sourceText, [
      ...(next.title ? [{ field: "title", text: next.title }] : []),
      ...(next.descriptionHtml !== undefined ? [{ field: "description", text: cleanDescription(next.descriptionHtml)?.text ?? "" }] : []),
    ]);
    return { changed: [...changed, ...(prices.changed.length ? ["prices"] : [])], warnings };
  });

  if (result.changed.length) await enqueuePendingTranslations(db, boss, { productIds: [id] });
  return { ...result, product: await detailOf(db, id) };
}

// Approving puts a product in the storefront. Refused when a variant has no price: a shopper can't buy it, and we
// never make a price up. The merchant has looked at the review reasons, so they're cleared: from then on, the reasons
// of an approved product are what a later upload found (it stays in the shop, see pipeline/build.ts). The listing's
// own problems are kept in content_review_reasons (without the "sent back" note) and come back if it's sent back
const approvable = sql`${products.deletedAt} is null
  and exists (select 1 from ${variants} v where v.product_id = ${products.id})
  and not exists (select 1 from ${variants} v where v.product_id = ${products.id} and v.price_cents is null)`;

async function approveWhere(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], ids: string[]) {
  if (!ids.length) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    update ${products} set
      status = 'approved', approved_at = now(), updated_at = now(),
      content_review_reasons = array(select r from unnest(content_review_reasons) as r where r not like ${`${SENT_BACK}%`}),
      review_reason = null
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
      const one = unpriced.length === 1;
      const reason = product.deletedAt
        ? "This product is deleted. Restore it first"
        : !mine.length
          ? "This product has no variants, so there's nothing to sell"
          : unpriced.length
            ? `${one ? "SKU" : "SKUs"} ${unpriced.join(", ")} ${one ? "has" : "have"} no price. Add ${one ? "it" : "them"} with Edit, or upload a sheet that has ${one ? "it" : "them"}, then approve`
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
// passed every check). A picked product that needs review is only approved when the merchant says so
// (includeNeedsReview): otherwise it's left out and listed, so nothing is approved without being looked at. Products
// that can't be approved are listed with the reason; the rest are approved. Approving never uses a new version
// waiting for an approved product: only "Use the new version" does (see applyNewVersion)
export async function bulkApprove(db: Db, target: { ids: string[]; includeNeedsReview?: boolean } | { importId: string }) {
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
  const askFirst = "ids" in target && !target.includeNeedsReview;
  const needsReview = ids.filter((id) => askFirst && !checked.get(id)!.reason && checked.get(id)!.status === "needs_review");
  const allowed = ids.filter((id) => !checked.get(id)!.reason && !needsReview.includes(id));
  const approved = await approveWhere(db, allowed);
  const skipped = ids.filter((id) => checked.get(id)!.reason).map((id) => ({ id, title: checked.get(id)!.title, reason: checked.get(id)!.reason! }));
  return {
    approved: approved.length,
    alreadyApproved: allowed.filter((id) => !approved.includes(id)).length,
    // Left as they are: they need review and the merchant didn't say to approve them anyway
    needsReview: needsReview.map((id) => ({ id, title: checked.get(id)!.title })),
    skipped,
  };
}

// A variant's options under the new version's names: { color: "lavender" } becomes { scent: "lavender" } once the
// new version calls the colour column "scent", and back again
function renamedOptions(options: Record<string, string>, from: OptionNames, to: OptionNames) {
  const plain = Object.fromEntries(Object.entries(options).map(([key, value]) => [key === from.color ? "color" : key === from.size ? "size" : key, value]));
  return renameOptions(plain, to);
}

// "Use the new version": the listing the AI wrote for an approved product replaces the one in the shop (fields the
// merchant changed by hand stay theirs). It stays approved: the merchant has just read it. Its English changed, so
// its translations are made again
export async function applyNewVersion(db: Db, boss: PgBoss, id: string) {
  await db.transaction(async (tx) => {
    const product = await lockProduct(tx, id);
    const next = newVersionOf(product);
    if (!next) throw new ProductActionError("There's no new version waiting for this product. It was used or dropped already", 409);
    for (const v of await tx.select().from(variants).where(eq(variants.productId, id))) {
      const options = renamedOptions(v.options, product.optionNames, next.optionNames);
      if (JSON.stringify(options) !== JSON.stringify(v.options)) await tx.update(variants).set({ options }).where(eq(variants.id, v.id));
    }
    await tx
      .update(products)
      .set({
        title: next.title,
        descriptionHtml: next.descriptionHtml,
        category: next.category,
        tags: next.tags,
        attributes: next.attributes,
        claims: next.claims,
        confidence: next.confidence,
        optionNames: next.optionNames,
        contentReviewReasons: next.reviewReasons,
        model: next.model,
        pendingListing: null,
      })
      .where(eq(products.id, id));
    // Only the fields whose English really changed get translated again
    await noteEnglishChange(tx, id);
  });
  await enqueuePendingTranslations(db, boss, { productIds: [id] });
  return { id, product: await detailOf(db, id) };
}

// "Keep the current one": the waiting version is dropped, the listing in the shop stays as it is. The same sheet
// uploaded again doesn't bring it back: the product already counts as written from that sheet with the current
// instructions (see savePendingListing in pipeline/build.ts), so it costs no AI call either
export async function keepCurrentListing(db: Db, id: string) {
  const dropped = await db.transaction(async (tx) => {
    const { pendingListing } = await lockProduct(tx, id);
    if (pendingListing) await tx.update(products).set({ pendingListing: null }).where(eq(products.id, id));
    return Boolean(pendingListing);
  });
  return { id, dropped, product: await detailOf(db, id) };
}

// The merchant sends a product back to review, with why. It leaves the storefront until it's approved again. The
// listing's own problems are shown again with the note (approving cleared them from the review reasons)
export async function sendBack(db: Db, id: string, reason: string) {
  const note = `${SENT_BACK}${reason.replace(/\s*;\s*/g, ", ").trim()}`;
  await db.transaction(async (tx) => {
    const product = await lockProduct(tx, id);
    const content = [note, ...product.contentReviewReasons.filter((r) => !r.startsWith(SENT_BACK))];
    const others = [...new Set([...splitReasons(product.reviewReason), ...product.contentReviewReasons])].filter((r) => !r.startsWith(SENT_BACK));
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
