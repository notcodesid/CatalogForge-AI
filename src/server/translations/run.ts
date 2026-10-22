import { and, eq, inArray } from "drizzle-orm";
import { askAi, type AskContext } from "@/server/ai/ask";
import { AiPermanentError, type AiProvider, type AiTier } from "@/server/ai/provider";
import type { Db } from "@/server/db/client";
import { products, translations, translationState, variants } from "@/server/db/schema";
import { finishImportIfComplete } from "@/server/pipeline/build";
import type { TranslateBatchJob } from "@/server/queue/queues";
import { checkField, cleanTranslated } from "./checks";
import {
  encodeValue,
  englishFields,
  fieldHashes,
  LANGUAGE_NAMES,
  type EnglishFields,
  type Locale,
  sameHashes,
  TRANSLATED_FIELDS,
  type TranslatedField,
  type TranslatedFields,
} from "./fields";
import { enabledLocales } from "./languages";
import { TRANSLATE_PROMPT_VERSION, translateResponseJsonSchema, translateResponseSchema, translateSystemPrompt, type TranslatedProduct } from "./prompt";
import { markDone, markFailed } from "./state";

// One product's work: the English, its fingerprints, and the fields to translate (new or changed English,
// and not written by the merchant)
type Work = { productId: string; english: EnglishFields; hashes: Record<string, string>; todo: TranslatedField[] };
type Outcome = { translated: TranslatedFields; model: string } | { error: string };

export async function runTranslateBatch(db: Db, provider: AiProvider, job: TranslateBatchJob, options: { signal?: AbortSignal } = {}) {
  const { locale } = job;
  // Switched off since the job was queued: nothing to do
  if ((await enabledLocales(db)).includes(locale)) {
    const work = await planWork(db, job);
    if (work.length) await translateAndSave(db, provider, job, work, options.signal);
  }
  if (job.importId) await finishImportIfComplete(db, job.importId);
}

async function planWork(db: Db, job: TranslateBatchJob): Promise<Work[]> {
  const ids = job.productIds;
  const [rows, productVariants, existing, states] = await Promise.all([
    db.select().from(products).where(inArray(products.id, ids)),
    db.select({ productId: variants.productId, options: variants.options }).from(variants).where(inArray(variants.productId, ids)),
    db.select().from(translations).where(and(inArray(translations.productId, ids), eq(translations.locale, job.locale))),
    db.select().from(translationState).where(and(inArray(translationState.productId, ids), eq(translationState.locale, job.locale))),
  ]);

  const work: Work[] = [];
  for (const product of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const state = states.find((s) => s.productId === product.id);
    // Deleted, already done, or the language was switched off for it
    if (product.deletedAt || state?.status !== "pending") continue;

    const english = englishFields(product, productVariants.filter((v) => v.productId === product.id));
    const hashes = fieldHashes(english);
    if (!sameHashes(hashes, product.englishHashes)) await db.update(products).set({ englishHashes: hashes }).where(eq(products.id, product.id));

    const mine = existing.filter((t) => t.productId === product.id);
    // An English field that's gone (the tags were removed): its AI translation goes too
    const gone = mine.filter((t) => t.writtenBy === "ai" && !(t.field in english)).map((t) => t.field);
    if (gone.length) {
      await db
        .delete(translations)
        .where(and(eq(translations.productId, product.id), eq(translations.locale, job.locale), eq(translations.writtenBy, "ai"), inArray(translations.field, gone)));
    }
    // A merchant's own translation is never redone. An AI one only when its English changed
    const todo = TRANSLATED_FIELDS.filter((field) => {
      if (english[field] === undefined) return false;
      const row = mine.find((t) => t.field === field);
      return !row || (row.writtenBy === "ai" && row.sourceHash !== hashes[field]);
    });
    if (todo.length) work.push({ productId: product.id, english, hashes, todo });
    else await markDone(db, product.id, job.locale, hashes);
  }
  return work;
}

async function translateAndSave(db: Db, provider: AiProvider, job: TranslateBatchJob, work: Work[], signal?: AbortSignal) {
  const ctx: AskContext = { db, provider, importId: job.importId, signal };
  let outcomes: Map<string, Outcome>;
  try {
    outcomes = await translate(ctx, job.locale, work);
  } catch (err) {
    // A refused request (bad key, unsupported input) won't work on a retry either
    if (err instanceof AiPermanentError) {
      await markFailed(
        db,
        work.map((w) => w.productId),
        job.locale,
        `The AI provider refused the request: ${err.message}`,
      );
      return;
    }
    throw err;
  }

  for (const item of work) {
    signal?.throwIfAborted();
    const outcome = outcomes.get(item.productId) ?? { error: "The AI didn't return this product" };
    if ("error" in outcome) {
      await markFailed(db, [item.productId], job.locale, outcome.error);
      continue;
    }
    for (const field of item.todo) {
      const problems = checkField(field, item.english, outcome.translated);
      const values = {
        value: encodeValue(cleanTranslated(field, item.english, outcome.translated)),
        sourceHash: item.hashes[field],
        writtenBy: "ai" as const,
        // A translation that failed a check is kept for the merchant to see, but shoppers get the English
        issue: problems.length ? sentence(problems.join("; ")) : null,
        updatedAt: new Date(),
      };
      await db
        .insert(translations)
        .values({ productId: item.productId, locale: job.locale, field, ...values })
        .onConflictDoUpdate({
          target: [translations.productId, translations.locale, translations.field],
          set: values,
          // The merchant's own translation always wins
          setWhere: eq(translations.writtenBy, "ai"),
        });
    }
    await markDone(db, item.productId, job.locale, item.hashes);
  }
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function problemCount(item: Work, translated: TranslatedFields) {
  return item.todo.reduce((sum, field) => sum + checkField(field, item.english, translated).length, 0);
}

// Asks the AI for a batch and copes with what can go wrong, like the AI step does: cut off -> split in half;
// broken JSON -> ask again, then the stronger model; a product missing -> ask for it alone. Then our checks:
// products whose translation has problems are asked once more, with the problems spelled out, of the stronger
// model; whichever answer has fewer problems is kept
async function translate(ctx: AskContext, locale: Locale, work: Work[], attempt = 0, feedback?: string, tier: AiTier = "cheap"): Promise<Map<string, Outcome>> {
  const input = {
    language: LANGUAGE_NAMES[locale],
    locale,
    products: work.map((w, i) => ({ key: String(i + 1), fields: Object.fromEntries(w.todo.map((f) => [f, w.english[f]])) })),
  };
  const answer = await askAi(ctx, {
    purpose: "translate",
    tier,
    promptVersion: TRANSLATE_PROMPT_VERSION,
    system: translateSystemPrompt(locale),
    input,
    schema: translateResponseSchema,
    jsonSchema: translateResponseJsonSchema,
    productCount: work.length,
    feedback,
  });
  const outcomes = new Map<string, Outcome>();

  if (answer.ok) {
    const missing: Work[] = [];
    work.forEach((w, i) => {
      const found = answer.data.products.find((p) => p.key === String(i + 1));
      if (found) outcomes.set(w.productId, { translated: withoutKey(found), model: answer.model });
      else missing.push(w);
    });
    if (missing.length && work.length > 1) {
      for (const w of missing) for (const [k, v] of await translate(ctx, locale, [w], attempt)) outcomes.set(k, v);
    } else {
      for (const w of missing) outcomes.set(w.productId, { error: "The AI didn't return this product" });
    }

    // Our checks found problems: one more try, with the problems listed, on the stronger model
    const flawed = work.filter((w) => {
      const outcome = outcomes.get(w.productId);
      return outcome && "translated" in outcome && problemCount(w, outcome.translated) > 0;
    });
    if (flawed.length && !feedback) {
      const notes = flawed.map((w, i) => {
        const outcome = outcomes.get(w.productId) as { translated: TranslatedFields };
        const problems = w.todo.flatMap((f) => checkField(f, w.english, outcome.translated).map((p) => `${f}: ${p}`));
        return `Product ${i + 1}: ${problems.join("; ")}`;
      });
      const ask = `Your previous answer for these products had problems. Fix them and translate again:\n${notes.join("\n")}`;
      const again = await translate(ctx, locale, flawed, attempt, ask, "strong");
      for (const w of flawed) {
        const second = again.get(w.productId);
        const first = outcomes.get(w.productId) as { translated: TranslatedFields; model: string };
        if (second && "translated" in second && problemCount(w, second.translated) <= problemCount(w, first.translated)) outcomes.set(w.productId, second);
      }
    }
    return outcomes;
  }

  if (answer.problem === "truncated") {
    if (work.length === 1) return new Map([[work[0].productId, { error: "The AI's answer was cut off, even for this product alone" }]]);
    const half = Math.ceil(work.length / 2);
    for (const part of [work.slice(0, half), work.slice(half)]) {
      for (const [k, v] of await translate(ctx, locale, part, attempt, feedback, tier)) outcomes.set(k, v);
    }
    return outcomes;
  }

  // Invalid answer: once more with the error explained, then once with the stronger model, then give up
  const explain = `Your previous answer was rejected: ${answer.error}. Answer again with valid JSON in the required shape only.`;
  if (attempt === 0) return translate(ctx, locale, work, 1, explain, tier);
  if (attempt === 1 && tier === "cheap") return translate(ctx, locale, work, 2, explain, "strong");
  throw new Error(`The AI returned invalid output ${attempt + 1} times: ${answer.error}`);
}

function withoutKey({ title, description_html, tags, attributes, options }: TranslatedProduct): TranslatedFields {
  return { title, description_html, tags, attributes, options };
}

// A batch that failed every try: its products are marked as failed, so the import can still finish
export async function failTranslateBatch(db: Db, job: TranslateBatchJob, reason: string) {
  await markFailed(db, job.productIds, job.locale, reason);
  if (job.importId) await finishImportIfComplete(db, job.importId);
}
