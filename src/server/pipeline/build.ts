import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { askAi, type AskContext } from "@/server/ai/ask";
import { normalizeForMatch } from "@/server/ai/claims";
import { renameOptions, replacedOptionKeys, type OptionNames } from "@/server/ai/option-names";
import { buildInput, buildProductInput, PROMPT_VERSION, SYSTEM_PROMPT, type ProductInput, type RowForBuild } from "@/server/ai/prompt";
import { AiPermanentError, type AiProvider, type AiTier } from "@/server/ai/provider";
import { AiPausedError } from "@/server/ai/rate-limit";
import { buildResponseJsonSchema, buildResponseSchema, type ProductDraft } from "@/server/ai/schema";
import { factWords, untranslatedText, verifyDraft, wordChecker, type VerifiedDraft } from "@/server/ai/verify";
import type { Db } from "@/server/db/client";
import { importRows, imports, photos, products, translationState, variants } from "@/server/db/schema";
import { linkPhotos } from "@/server/photos/match";
import { noteEnglishChange } from "@/server/translations/state";
import type { BuildBatchJob } from "@/server/queue/queues";
import { LONG_DESCRIPTION_CHARS } from "./clean/html";
import { skuKey } from "./clean/row";
import { nameKey } from "./group";
import type { CleanedRow, ParseInfo } from "./types";

// Products per AI call. One call for 10 products costs far less than 10 calls (the instructions are sent once)
const BATCH_SIZE = 10;
const LOOKUP_CHUNK = 1000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

export type BuildRow = RowForBuild & { id: number; rowHash: string; status: string; productKey: string | null };

// ---------- Planning: which products go to the AI, in which batches ----------

// Messy products get the stronger (more expensive) model, clean ones the cheap one
function chooseTier(rows: { cleaned: CleanedRow }[]): AiTier {
  const messy = rows.some(
    ({ cleaned }) =>
      cleaned.language === "de" ||
      cleaned.language === "fr" ||
      (cleaned.role === "variant" && !cleaned.title) ||
      (cleaned.descriptionText?.length ?? 0) > LONG_DESCRIPTION_CHARS ||
      cleaned.issues.some((i) => i.severity === "review" && (i.field === "sku" || i.field === "title")),
  );
  return messy ? "strong" : "cheap";
}

// Fingerprint of a product's supplier rows. Same fingerprint on a re-upload = nothing changed = no AI call
export function sourceHashFor(rows: { rowHash: string }[]): string {
  const hashes = rows.map((r) => r.rowHash).sort();
  return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
}

function planBatches(groups: { key: string; tier: AiTier }[]): { productKeys: string[]; tier: AiTier }[] {
  const batches: { productKeys: string[]; tier: AiTier }[] = [];
  for (const tier of ["cheap", "strong"] as const) {
    const keys = groups.filter((g) => g.tier === tier).map((g) => g.key).sort();
    for (let i = 0; i < keys.length; i += BATCH_SIZE) batches.push({ productKeys: keys.slice(i, i + BATCH_SIZE), tier });
  }
  return batches;
}

// A key that's the same for the same batch, so the queue refuses a second copy of it
export function batchKey(importId: string, productKeys: string[]) {
  return `${importId}:${createHash("sha256").update(productKeys.join("\n")).digest("hex").slice(0, 16)}`;
}

export function groupByProduct<T extends { productKey: string | null }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.productKey) continue;
    groups.set(row.productKey, [...(groups.get(row.productKey) ?? []), row]);
  }
  return groups;
}

// Does this file say anything about a product that its listing wasn't already written from?
function saysNothingNew(next: ProductInput, current: ProductInput, nextHasDescription: boolean): boolean {
  const texts = (input: ProductInput) => new Set(input.sourceRows.flatMap((r) => Object.values(r.cells)).map(normalizeForMatch));
  const nextTexts = texts(next);
  const currentTexts = texts(current);
  // Exactly the same text as before: only prices, stock or variants changed
  if (nextTexts.size === currentTexts.size && [...nextTexts].every((t) => currentTexts.has(t))) return true;
  // Any description or notes that differ might correct the listing (a claim taken out), so the AI rewrites it.
  // A file without any (a price list) can only make the listing shorter, unless it brings words we haven't seen
  if (nextHasDescription) return false;
  const isKnown = wordChecker([...currentTexts]);
  return factWords([...nextTexts].join(" ")).every(isKnown);
}

type Planned = { rowNumber: number; raw: Record<string, string>; cleaned: CleanedRow | null };

// Products already in the catalog that this upload has nothing new to say about, e.g. a price list for products
// imported earlier from a richer sheet. Their listing is kept and only prices and variants are updated, so a
// thin file can't wipe a good listing, and they cost no AI call
async function listingsToKeep(db: DbOrTx, groups: Map<string, Planned[]>, info: ParseInfo | null): Promise<Set<string>> {
  if (!info) return new Set();
  type Current = { id: string; sourceInput: ProductInput | null; promptVersion: string | null; deletedAt: Date | null };
  const keys = [...groups.keys()];
  const byKey = new Map<string, Current>();
  const bySku = new Map<string, Current>();
  for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
    const found = await db
      .select({ key: products.productKey, id: products.id, sourceInput: products.sourceInput, promptVersion: products.promptVersion, deletedAt: products.deletedAt })
      .from(products)
      .where(inArray(products.productKey, keys.slice(i, i + LOOKUP_CHUNK)));
    for (const { key, ...product } of found) byKey.set(key, product);
  }
  // Not found by key: look for its SKUs, the same way saveProduct does
  const skus = keys.filter((k) => !byKey.has(k)).flatMap((k) => groups.get(k)!.map((r) => r.cleaned?.sku).filter((s): s is string => Boolean(s)));
  for (let i = 0; i < skus.length; i += LOOKUP_CHUNK) {
    const found = await db
      .select({ sku: variants.sku, id: products.id, sourceInput: products.sourceInput, promptVersion: products.promptVersion, deletedAt: products.deletedAt })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(inArray(variants.sku, skus.slice(i, i + LOOKUP_CHUNK)));
    for (const { sku, ...product } of found) bySku.set(sku, product);
  }

  const keep = new Set<string>();
  for (const [key, group] of groups) {
    const rows = group.filter((r): r is RowForBuild => r.cleaned !== null);
    const owners = new Map(rows.flatMap((r) => (r.cleaned.sku && bySku.has(r.cleaned.sku) ? [bySku.get(r.cleaned.sku)!] : [])).map((p) => [p.id, p]));
    const current = byKey.get(key) ?? (owners.size === 1 ? [...owners.values()][0] : undefined);
    // A listing written with older instructions is written again: better instructions are why the version changed
    if (!current?.sourceInput || current.deletedAt || current.promptVersion !== PROMPT_VERSION) continue;
    const next = buildProductInput(key, rows, info).input;
    const hasDescription = rows.some((r) => r.cleaned.descriptionText || r.cleaned.notes);
    if (saysNothingNew(next, current.sourceInput, hasDescription)) keep.add(key);
  }
  return keep;
}

// The batches for these products: AI batches by tier, and "prices only" batches for products whose listing is
// kept. Used when an import is planned, and when the watchdog queues again batches that went missing
export async function planBuildBatches(db: DbOrTx, groups: Map<string, Planned[]>, info: ParseInfo | null): Promise<Omit<BuildBatchJob, "importId">[]> {
  const keep = await listingsToKeep(db, groups, info);
  const planned = [...groups].map(([key, rows]) => ({ key, tier: chooseTier(rows.flatMap((r) => (r.cleaned ? [{ cleaned: r.cleaned }] : []))) }));
  return [
    ...planBatches(planned.filter((p) => !keep.has(p.key))),
    ...planBatches(planned.filter((p) => keep.has(p.key))).map((b) => ({ ...b, keepListing: true })),
  ];
}

// Marks the import done once every row has its final status, every photo is processed and its products are
// translated (or their translation failed, with the reason). Safe to call from many batches at once
export async function finishImportIfComplete(db: DbOrTx, importId: string) {
  await db.execute(sql`
    update ${imports} set status = 'done', finished_at = now(), updated_at = now()
    where id = ${importId} and status in ('queued', 'running', 'paused') and stage = 'build'
      and build_planned_at is not null
      and not exists (select 1 from ${importRows} where import_id = ${importId} and status in ('pending', 'processing'))
      and not exists (select 1 from ${photos} where import_id = ${importId} and processed_at is null and status <> 'rejected')
      and not exists (
        select 1 from ${translationState} ts join ${products} p on p.id = ts.product_id
        where p.last_import_id = ${importId} and p.deleted_at is null and ts.status = 'pending'
      )
  `);
}

// ---------- Running one batch ----------

type Outcome = { draft: ProductDraft; model: string } | { error: string };


export async function runBuildBatch(db: Db, provider: AiProvider, job: BuildBatchJob, options: { signal?: AbortSignal } = {}) {
  const [imp] = await db.select().from(imports).where(eq(imports.id, job.importId));
  if (!imp || imp.status === "failed" || imp.status === "done" || !imp.parseInfo) return;
  // Work is happening again after a pause
  if (imp.status === "paused") await db.update(imports).set({ status: "running" }).where(and(eq(imports.id, imp.id), eq(imports.status, "paused")));

  const rows: BuildRow[] = await db
    .select({
      id: importRows.id,
      rowNumber: importRows.rowNumber,
      raw: importRows.raw,
      cleaned: sql<CleanedRow>`${importRows.cleaned}`,
      rowHash: importRows.rowHash,
      status: importRows.status,
      productKey: importRows.productKey,
    })
    .from(importRows)
    .where(and(eq(importRows.importId, job.importId), inArray(importRows.productKey, job.productKeys)))
    // A fixed order makes the AI input identical on a retry, so the cached answer is found (no paying twice)
    .orderBy(asc(importRows.rowNumber));

  const groups = [...groupByProduct(rows).entries()].sort(([a], [b]) => a.localeCompare(b));
  if (!groups.some(([, group]) => group.some((r) => r.status === "pending"))) return finishImportIfComplete(db, job.importId);

  if (job.keepListing) {
    for (const [key, group] of groups) {
      if (!group.some((r) => r.status === "pending")) continue;
      options.signal?.throwIfAborted();
      await updatePricesOnly(db, imp.id, key, group.filter((r) => r.status !== "failed"));
    }
    return finishImportIfComplete(db, job.importId);
  }

  // The AI is always asked about the whole batch, even on a retry where some products were already saved:
  // the question is then exactly the same as the first time, so its answer comes from the cache for free.
  // Only products that still have rows waiting get saved
  const prepared = groups.map(([key, group]) => {
    const live = group.filter((r) => r.status !== "failed");
    return { key, rows: live, waiting: group.some((r) => r.status === "pending"), ...buildProductInput(key, live, imp.parseInfo!) };
  });

  let outcomes: Map<string, Outcome>;
  try {
    outcomes = await draftProducts({ db, provider, importId: job.importId, signal: options.signal }, job.tier, prepared.map((p) => p.input));
  } catch (err) {
    // A refused request (bad key, unsupported input) won't work on a retry either
    if (err instanceof AiPermanentError) {
      await failProducts(db, job, `The AI provider refused the request: ${err.message}`);
      return;
    }
    // Rate limited for a while, or out of credit: the merchant sees "Paused", the worker puts this batch back in the queue
    if (err instanceof AiPausedError) {
      await db.update(imports).set({ status: "paused" }).where(and(eq(imports.id, job.importId), eq(imports.status, "running")));
    }
    throw err;
  }

  for (const product of prepared) {
    if (!product.waiting) continue;
    options.signal?.throwIfAborted();
    const outcome = outcomes.get(product.key) ?? { error: "The AI didn't return this product" };
    await saveProduct(db, imp, product.key, product.rows, product.input, outcome, product.truncated);
  }
  await finishImportIfComplete(db, job.importId);
}

// Marks the products of a batch as failed. Used when the AI keeps failing on them
export async function failProducts(db: Db, job: BuildBatchJob, reason: string) {
  await db
    .update(importRows)
    .set({ status: "failed", reason })
    .where(
      and(
        eq(importRows.importId, job.importId),
        inArray(importRows.productKey, job.productKeys),
        inArray(importRows.status, ["pending", "processing"]),
      ),
    );
  await finishImportIfComplete(db, job.importId);
}

// Asks the AI for a batch and copes with what can go wrong with the answer:
// cut off -> split the batch in half; broken JSON -> ask again, then ask the stronger model;
// a product missing from the answer -> ask for it alone; German/French copied instead of translated -> ask once more
async function draftProducts(
  ctx: AskContext,
  tier: AiTier,
  inputs: ProductInput[],
  attempt = 0,
  feedback?: string,
  translationRetried = false,
): Promise<Map<string, Outcome>> {
  const answer = await askOnce(ctx, tier, inputs, feedback);
  const outcomes = new Map<string, Outcome>();

  if (answer.ok) {
    const missing: ProductInput[] = [];
    for (const input of inputs) {
      const draft = answer.drafts.find((d) => d.key === input.key);
      if (draft) outcomes.set(input.key, { draft, model: answer.model });
      else missing.push(input);
    }
    if (missing.length && inputs.length > 1) {
      for (const input of missing) for (const [k, v] of await draftProducts(ctx, tier, [input])) outcomes.set(k, v);
    } else {
      for (const input of missing) outcomes.set(input.key, { error: "The AI didn't return this product" });
    }

    // The AI copied German or French text instead of translating it: ask once more for just those products.
    // If it still doesn't translate, the check in verifyDraft sends them to review
    const untranslated = inputs.filter((input) => {
      const outcome = outcomes.get(input.key);
      return outcome && "draft" in outcome && untranslatedText(outcome.draft, input);
    });
    if (untranslated.length && !translationRetried) {
      const ask = "Your previous answer copied the supplier's German or French text. Translate title, description_html, tags and attribute values into English.";
      for (const [k, v] of await draftProducts(ctx, tier, untranslated, attempt, ask, true)) outcomes.set(k, v);
    }
    return outcomes;
  }

  if (answer.problem === "truncated") {
    if (inputs.length === 1) return new Map([[inputs[0].key, { error: "The AI's answer was cut off, even for this product alone" }]]);
    const half = Math.ceil(inputs.length / 2);
    for (const part of [inputs.slice(0, half), inputs.slice(half)]) {
      for (const [k, v] of await draftProducts(ctx, tier, part, attempt)) outcomes.set(k, v);
    }
    return outcomes;
  }

  // Invalid answer: once more with the error explained, then once with the stronger model, then give up
  const explain = `Your previous answer was rejected: ${answer.error}. Answer again with valid JSON in the required shape only.`;
  if (attempt === 0) return draftProducts(ctx, tier, inputs, 1, explain);
  if (attempt === 1 && tier === "cheap") return draftProducts(ctx, "strong", inputs, 2, explain);
  throw new Error(`The AI returned invalid output ${attempt + 1} times: ${answer.error}`);
}

type Answer = { ok: true; drafts: ProductDraft[]; model: string } | { ok: false; problem: "truncated" | "invalid"; error: string };

async function askOnce(ctx: AskContext, tier: AiTier, inputs: ProductInput[], feedback?: string): Promise<Answer> {
  const answer = await askAi(ctx, {
    purpose: "build",
    tier,
    promptVersion: PROMPT_VERSION,
    system: SYSTEM_PROMPT,
    input: buildInput(inputs),
    schema: buildResponseSchema,
    jsonSchema: buildResponseJsonSchema,
    productCount: inputs.length,
    feedback,
  });
  return answer.ok ? { ok: true, drafts: answer.data.products, model: answer.model } : answer;
}

// ---------- Saving ----------

// Problems found while cleaning and grouping, written so the merchant can find the row. The sheet's price problems
// ("No price", two rows with different prices) are left out for a variant whose price the merchant set by hand:
// their price is the one that counts (pricedByHand holds skuKey()s)
export function rowReasons(rows: { rowNumber: number; cleaned: CleanedRow }[], key: string, pricedByHand = new Set<string>()): string[] {
  const reasons: string[] = [];
  for (const row of [...rows].sort((a, b) => a.rowNumber - b.rowNumber)) {
    const handPriced = pricedByHand.has(skuKey(skuOf(key, row.cleaned)));
    for (const issue of row.cleaned.issues) {
      if (issue.severity !== "review" || (handPriced && issue.field === "price")) continue;
      reasons.push(/^(Rows|SKUs|Variants) /.test(issue.message) ? issue.message : `Row ${row.rowNumber}: ${issue.message}`);
    }
  }
  return [...new Set(reasons)];
}

function slugify(text: string) {
  return normalizeForMatch(text).replace(/%/g, "").split(" ").filter(Boolean).join("-").slice(0, 60).replace(/-+$/, "") || "product";
}

// "terracotta-planter", or "terracotta-planter-2" if that's taken. Batches run side by side, so two of them can
// look for a free "glazed-vase-N" at the same moment and pick the same one. A lock on the name (held until the
// transaction ends) makes the second one wait, and then it sees the first one's choice
async function freeHandle(tx: Tx, base: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`handle:${base}`}))`);
  const taken = new Set(
    (await tx.select({ handle: products.handle }).from(products).where(or(eq(products.handle, base), like(products.handle, `${base}-%`)))).map((p) => p.handle),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// A product without a supplier SKU gets one made from the product and its options, so it's the same on every re-upload
function generatedSku(productKey: string, row: CleanedRow) {
  const options = JSON.stringify([row.size, row.color, row.options]);
  return `GEN-${createHash("sha256").update(productKey + options).digest("hex").slice(0, 8).toUpperCase()}`;
}

// The SKU a row's variant is saved under
const skuOf = (productKey: string, row: CleanedRow) => row.sku ?? generatedSku(productKey, row);

// JSON with object keys sorted. Postgres keeps jsonb keys in its own order, so a value read back can list them
// differently from the same value built here
function stableJson(value: unknown) {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

// Whether these values are already what's saved (fields in `ignore` don't count)
function unchanged<T extends object>(saved: T, next: Partial<T>, ignore = new Set<string>()) {
  return Object.entries(next).every(([field, value]) => ignore.has(field) || stableJson(value) === stableJson(saved[field as keyof T]));
}

// Fields that only say which file and rows last wrote a product. Every re-upload changes them, so they aren't a
// change the merchant would see
const BOOKKEEPING = new Set(["lastImportId", "sourceRows", "sourceHash", "sourceInput"]);

// The product's "Updated" time after a save: kept when nothing the merchant sees changed (same listing, status and
// variants), so re-uploading a sheet doesn't make every product look just changed. Given explicitly to the save's
// last write, it also replaces the time the earlier writes put there
function updatedAtAfter(before: Product, next: Partial<Product>, variantsChanged: boolean): Date {
  return variantsChanged || !unchanged(before, next, BOOKKEEPING) ? new Date() : before.updatedAt;
}

async function saveProduct(
  db: Db,
  imp: { id: string; sheetFileName: string },
  key: string,
  rows: BuildRow[],
  input: ProductInput,
  outcome: Outcome,
  truncated: boolean,
) {
  const importId = imp.id;
  const pendingRows = and(eq(importRows.importId, importId), eq(importRows.productKey, key), inArray(importRows.status, ["pending", "processing"]));

  if ("error" in outcome) {
    await db.update(importRows).set({ status: "failed", reason: outcome.error }).where(pendingRows);
    return;
  }

  const verified: VerifiedDraft = verifyDraft(outcome.draft, input);
  // Problems with the listing itself. Kept on the product, so a later price-only update still shows them
  const contentReasons = [
    ...(truncated ? [`The description was too long, the AI only read the first ${LONG_DESCRIPTION_CHARS.toLocaleString("en")} characters`] : []),
    ...verified.reviewReasons,
  ];

  const variantRows = rows.filter((r) => r.cleaned.role === "variant" && !r.cleaned.duplicateOfRow);

  await db.transaction(async (tx) => {
    const found = await findExisting(tx, key, variantRows);
    // The merchant deleted this product: a file that has it under another layout doesn't bring it back
    if (found?.product.deletedAt) return skipDeleted(tx, importId, key, pendingRows);
    const existing = found?.product;
    const renamed =
      found?.bySku && nameKey(found.product.title) !== nameKey(verified.title || found.product.title)
        ? [`These SKUs belonged to "${found.product.title}", which is now called "${verified.title}". Check it's the same product`]
        : [];
    // Fields the merchant changed by hand are never overwritten by the AI
    const edited = new Set(existing?.merchantEditedFields ?? []);
    const pick = <T>(field: string, fresh: T, current: T | undefined) => (existing && edited.has(field) ? (current as T) : fresh);

    const content = {
      title: pick("title", verified.title || key, existing?.title),
      descriptionHtml: pick("descriptionHtml", verified.descriptionHtml, existing?.descriptionHtml),
      category: pick("category", verified.category, existing?.category),
      tags: pick("tags", verified.tags, existing?.tags),
      attributes: pick("attributes", verified.attributes, existing?.attributes),
      // With the file name: a listing can outlive its file (a later price list keeps it), so "row 2" alone is unclear
      claims: verified.claims.map((c) => ({ ...c, source: `${imp.sheetFileName}, ${c.source}` })),
      confidence: verified.confidence,
      optionNames: verified.optionNames,
      sourceRows: rows.map((r) => r.rowNumber).sort((a, b) => a - b),
      lastImportId: importId,
      sourceHash: sourceHashFor(rows),
      sourceInput: input,
      contentReviewReasons: contentReasons,
      model: outcome.model,
      promptVersion: PROMPT_VERSION,
    };

    const productId = existing
      ? (await tx.update(products).set(content).where(eq(products.id, existing.id)).returning({ id: products.id }))[0].id
      : (
          await tx
            .insert(products)
            .values({ ...content, productKey: key, handle: await freeHandle(tx, slugify(verified.title || key)) })
            .returning({ id: products.id })
        )[0].id;

    const saved = await saveVariants(tx, productId, key, variantRows, verified.optionNames, existing?.optionNames);
    const reasons = [...rowReasons(rows, key, saved.pricedByHand), ...contentReasons, ...renamed, ...saved.problems];
    await linkPhotos(tx, importId, { productKey: key, productId });
    // New or changed English: its translations are marked to do (queued by the worker after this batch)
    await noteEnglishChange(tx, productId);

    // New English from the AI: an approved product needs another look before it's back in the shop
    const status: Product["status"] = reasons.length ? "needs_review" : "ready";
    const result = { status, reviewReason: reasons.length ? reasons.join("; ") : null, approvedAt: null };
    await tx
      .update(products)
      .set({ ...result, updatedAt: existing ? updatedAtAfter(existing, { ...content, ...result }, saved.changed) : new Date() })
      .where(eq(products.id, productId));
    await tx
      .update(importRows)
      .set({ status: status === "ready" ? "done" : "needs_review", reason: result.reviewReason })
      .where(pendingRows);
  });
}

type Product = typeof products.$inferSelect;

// The product these rows update, locked until the transaction ends. Found by key, or else by SKU: the same
// products uploaded before from a differently laid out file are the same products, so they're updated instead
// of duplicated. SKUs spread over several products are a real conflict and get flagged per SKU in saveVariants
async function findExisting(tx: Tx, key: string, variantRows: BuildRow[]): Promise<{ product: Product; bySku: boolean } | undefined> {
  const [byKey] = await tx.select().from(products).where(eq(products.productKey, key)).for("update");
  if (byKey) return { product: byKey, bySku: false };

  const skus = variantRows.map((r) => r.cleaned.sku).filter((s): s is string => Boolean(s));
  if (!skus.length) return undefined;
  const owners = await tx.selectDistinct({ id: variants.productId }).from(variants).where(inArray(variants.sku, skus));
  if (owners.length !== 1) return undefined;
  const [product] = await tx.select().from(products).where(eq(products.id, owners[0].id)).for("update");
  // From now on this product is found by the newest file's key, so re-uploading that file costs no AI call
  const [taken] = await tx.select({ id: products.id }).from(products).where(eq(products.productKey, key));
  if (!taken) await tx.update(products).set({ productKey: key }).where(eq(products.id, product.id));
  return { product, bySku: true };
}

type SavedVariants = { problems: string[]; changed: boolean; pricedByHand: Set<string> };

// Variants come from our cleaned rows, never from the AI: the AI only names what a colour or size column really
// holds (names: { color: "scent" }; previous: the names the product had). Returns what needs a person (SKUs that
// belong to another product, variants from an earlier upload, not in this file, that still have no price), whether
// any variant changed, and the skuKey()s of the variants whose price the merchant set by hand
async function saveVariants(
  tx: Tx,
  productId: string,
  key: string,
  variantRows: BuildRow[],
  names: OptionNames = {},
  previous: OptionNames = {},
): Promise<SavedVariants> {
  // Rows with the same SKU but different data (exact copies were merged while grouping) make one variant, with the
  // first row's values. If their prices differ it gets no price: we never pick one, the merchant enters it in Edit
  const bySku = new Map<string, CleanedRow[]>();
  for (const { cleaned } of variantRows) {
    const sku = skuKey(skuOf(key, cleaned));
    bySku.set(sku, [...(bySku.get(sku) ?? []), cleaned]);
  }
  const wanted = [...bySku.values()].map(([c, ...others], position) => {
    const onePrice = others.every((o) => o.priceCents === c.priceCents && o.currency === c.currency);
    const options = { ...(c.size ? { size: c.size } : {}), ...(c.color ? { color: c.color } : {}), ...c.options } as Record<string, string>;
    return {
      sku: skuOf(key, c),
      options: renameOptions(options, names),
      // Keys saved before under another name ("color" now that it's "scent"): dropped, not left next to the new one
      replaced: replacedOptionKeys(options, names, previous),
      priceCents: onePrice ? c.priceCents : null,
      currency: onePrice ? c.currency : null,
      weightGrams: c.weightGrams,
      position,
    };
  });

  // This product's variants as they are now. Only written while the product is locked (see findExisting), so they
  // can't change before we write
  const found = wanted.length ? await tx.select().from(variants).where(inArray(variants.sku, wanted.map((v) => v.sku))) : [];
  const current = new Map(found.filter((v) => v.productId === productId).map((v) => [v.sku, v]));

  const problems: string[] = [];
  let changed = false;
  for (const { sku, replaced, ...fresh } of wanted) {
    const before = current.get(sku);
    // A file without a colour or weight column (a price list) doesn't erase what an earlier file said, and a price
    // the merchant set by hand stays theirs
    const values = before
      ? {
          ...fresh,
          options: { ...Object.fromEntries(Object.entries(before.options).filter(([k]) => !replaced.includes(k))), ...fresh.options },
          weightGrams: fresh.weightGrams ?? before.weightGrams,
          ...(before.priceSetByHand ? { priceCents: before.priceCents, currency: before.currency } : {}),
        }
      : fresh;
    // Nothing new: not written, so its "updated" time stays
    if (before && unchanged(before, values)) continue;
    const [saved] = await tx
      .insert(variants)
      .values({ productId, sku, ...values })
      .onConflictDoUpdate({ target: variants.sku, set: values, setWhere: eq(variants.productId, productId) })
      .returning({ id: variants.id });
    // The SKU is already used by a different product: don't move it, ask a person
    if (!saved) problems.push(`SKU ${sku} already belongs to another product`);
    else changed = true;
  }

  // This file's own rows report their missing prices themselves
  const inFile = new Set(wanted.map((v) => v.sku));
  const unpriced = await tx
    .select({ sku: variants.sku })
    .from(variants)
    .where(and(eq(variants.productId, productId), isNull(variants.priceCents)))
    .orderBy(asc(variants.sku));
  for (const { sku } of unpriced) if (!inFile.has(sku)) problems.push(`SKU ${sku} still has no price (from an earlier upload)`);
  const pricedByHand = new Set([...current.values()].filter((v) => v.priceSetByHand).map((v) => skuKey(v.sku)));
  return { problems, changed, pricedByHand };
}

const LISTING_KEPT = "Prices and variants updated. The listing was kept: this file has nothing new to say about the product";
export const DELETED_SKIP = "Skipped: you deleted this product. Restore it to import it again";
export const DELETED_PHOTO = "Its product was deleted. Restore the product to use this photo";

// A product the merchant deleted stays deleted: its rows are done with the reason, its photos are left unmatched
async function skipDeleted(tx: Tx, importId: string, key: string, pendingRows: ReturnType<typeof and>) {
  await tx.update(importRows).set({ status: "done", reason: DELETED_SKIP }).where(pendingRows);
  await tx
    .update(photos)
    .set({ status: "unmatched", reason: DELETED_PHOTO })
    .where(and(eq(photos.importId, importId), eq(photos.status, "matched"), eq(photos.productKey, key), eq(photos.assignedByHand, false)));
}

// For a product this file has nothing new to say about (see listingsToKeep): new prices, weights and variants
// are saved, the listing stays as it is. An approved product stays approved unless a row has a problem
async function updatePricesOnly(db: Db, importId: string, key: string, rows: BuildRow[]) {
  const pendingRows = and(eq(importRows.importId, importId), eq(importRows.productKey, key), inArray(importRows.status, ["pending", "processing"]));
  const variantRows = rows.filter((r) => r.cleaned.role === "variant" && !r.cleaned.duplicateOfRow);

  await db.transaction(async (tx) => {
    const found = await findExisting(tx, key, variantRows);
    if (!found) {
      const reason = "The product this file updates is no longer in the catalog. Upload the file again";
      await tx.update(importRows).set({ status: "failed", reason }).where(pendingRows);
      return;
    }
    if (found.product.deletedAt) return skipDeleted(tx, importId, key, pendingRows);
    const { product } = found;
    const saved = await saveVariants(tx, product.id, key, variantRows, product.optionNames, product.optionNames);
    const reasons = [...rowReasons(rows, key, saved.pricedByHand), ...product.contentReviewReasons, ...saved.problems];
    await linkPhotos(tx, importId, { productKey: key, productId: product.id });
    // The listing is kept, but new variants can bring new option values (a new colour) to translate
    await noteEnglishChange(tx, product.id);
    const status: Product["status"] = reasons.length ? "needs_review" : product.status === "approved" ? "approved" : "ready";
    const reviewReason = reasons.length ? reasons.join("; ") : null;
    const next = {
      status,
      reviewReason,
      approvedAt: status === "approved" ? product.approvedAt : null,
      sourceRows: rows.map((r) => r.rowNumber).sort((a, b) => a - b),
      lastImportId: importId,
      sourceHash: sourceHashFor(rows),
    };
    await tx
      .update(products)
      .set({ ...next, updatedAt: updatedAtAfter(product, next, saved.changed) })
      .where(eq(products.id, product.id));
    await tx
      .update(importRows)
      .set({ status: reasons.length ? "needs_review" : "done", reason: reviewReason ?? LISTING_KEPT })
      .where(pendingRows);
  });
}
