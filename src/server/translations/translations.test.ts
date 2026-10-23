import { rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockProvider, resetMockState } from "@/server/ai/mock";
import { AiPermanentError, type AiProvider, type AiRequest } from "@/server/ai/provider";
import { createDb } from "@/server/db/client";
import { products, translations, translationState } from "@/server/db/schema";
import { env } from "@/server/env";
import { getImportSummary } from "@/server/imports/queries";
import { runBuildBatch } from "@/server/pipeline/build";
import { runParseImport } from "@/server/pipeline/run-parse-import";
import { queues, type BuildBatchJob, type TranslateBatchJob } from "@/server/queue/queues";
import { startTestBoss } from "@/test/boss";
import { createTestImport, setShopLanguages } from "@/test/fixtures";
import { testDatabaseUrl } from "@/test/global-setup";
import { translationCoverage } from "./coverage";
import type { TranslateInput } from "./prompt";
import { confirmTranslation, productTranslations, revertToAi, writeTranslation } from "./merchant";
import { runTranslateBatch } from "./run";
import { LanguageSettingError, setCountryEnabled } from "./settings";
import { enqueuePendingTranslations, noteEnglishChange, retryFailed } from "./state";

const db = createDb(testDatabaseUrl());
let boss: PgBoss;
const SAMPLE = "samples/catalogforge_test_sheet.csv";

// The mock AI, with every question it's asked written down
const asked: AiRequest[] = [];
let provider: AiProvider = mockProvider;
const spy: AiProvider = {
  ...mockProvider,
  generate: (request) => {
    asked.push(request);
    return provider.generate(request);
  },
};
const translateCalls = () => asked.filter((r) => r.purpose === "translate");
const fieldsAsked = (r: AiRequest) => (r.input as TranslateInput).products.map((p) => Object.keys(p.fields).sort());

beforeAll(async () => {
  boss = await startTestBoss();
});

beforeEach(async () => {
  await db.execute(sql`truncate imports, products, ai_cache, ai_calls, ai_status restart identity cascade`);
  await boss.deleteAllJobs();
  await setShopLanguages(db, true);
  delete process.env.MOCK_AI_MODE;
  resetMockState();
  asked.length = 0;
  provider = mockProvider;
});

afterAll(async () => {
  await boss.stop();
  await db.$client.end();
  rmSync(env().STORAGE_DIR, { recursive: true, force: true });
});

// What the worker does: read the sheet, run every AI batch, then queue the translations
async function importSheet(file = SAMPLE) {
  const id = await createTestImport(db, file);
  const queued: BuildBatchJob[] = [];
  await runParseImport(db, id, { enqueueBuild: async (_tx, jobs) => void queued.push(...jobs.map((j) => j.data)) });
  for (const job of queued) await runBuildBatch(db, spy, job);
  await enqueuePendingTranslations(db, boss, { importId: id });
  return id;
}

// Takes every queued translation job, runs it and marks it complete, like the worker
async function runTranslations() {
  for (;;) {
    const jobs = await boss.fetch<TranslateBatchJob>(queues.translateBatch.name, { batchSize: 100 });
    if (!jobs.length) return;
    for (const job of jobs) await runTranslateBatch(db, spy, job.data);
    await boss.complete(
      queues.translateBatch.name,
      jobs.map((j) => j.id),
    );
  }
}

async function productByTitle(title: string) {
  const [row] = await db.select().from(products).where(eq(products.title, title));
  return row;
}

async function changeEnglishTitle(productId: string, title: string) {
  await db.update(products).set({ title }).where(eq(products.id, productId));
  await noteEnglishChange(db, productId);
  await enqueuePendingTranslations(db, boss, { productIds: [productId] });
}

describe("translations", () => {
  it("translates every product into German and French after the AI step, and the import waits for it", async () => {
    const id = await importSheet();
    expect(await getImportSummary(db, id)).toMatchObject({ status: "running", phase: "translating", translations: { de: { pending: 12 }, fr: { pending: 12 } } });

    await runTranslations();
    expect(await getImportSummary(db, id)).toMatchObject({ status: "done", translations: { de: { done: 12, pending: 0, failed: 0 }, fr: { done: 12 } } });
    // 12 products, 10 per call, one language per call
    expect(translateCalls()).toHaveLength(4);

    const planter = await productByTitle("Hand-thrown Terracotta Planter");
    const view = await productTranslations(db, planter.id);
    const german = view.languages.find((l) => l.locale === "de")!;
    expect(german).toMatchObject({ enabled: true, status: "done", fields: { title: { value: "Hand-thrown Terracotta Planter [DE]", writtenBy: "ai", issue: null, upToDate: true } } });
    expect(german.shown).toMatchObject({ title: "Hand-thrown Terracotta Planter [DE]", category: "Haus & Garten > Pflanzgefäße" });
    expect(german.shown.sources).toMatchObject({ title: "ai", description_html: "ai", tags: "ai", attributes: "ai", options: "ai" });
  });

  it("translates only the field whose English changed", async () => {
    await importSheet();
    await runTranslations();
    const planter = await productByTitle("Hand-thrown Terracotta Planter");
    const [descriptionBefore] = await db
      .select()
      .from(translations)
      .where(and(eq(translations.productId, planter.id), eq(translations.locale, "de"), eq(translations.field, "description_html")));
    asked.length = 0;

    await changeEnglishTitle(planter.id, "Large Terracotta Planter");
    await runTranslations();
    // One call per language, asking for the title alone
    expect(translateCalls().map(fieldsAsked)).toEqual([[["title"]], [["title"]]]);
    const german = (await productTranslations(db, planter.id)).languages.find((l) => l.locale === "de")!;
    expect(german.fields.title).toMatchObject({ value: "Large Terracotta Planter [DE]", upToDate: true });
    expect(german.fields.description_html.value).toBe(descriptionBefore.value);
  });

  it("translates a tag that is also a colour like the colour already saved, when only the tags change", async () => {
    await importSheet();
    await runTranslations();
    const planter = await productByTitle("Hand-thrown Terracotta Planter");
    // As the real AI would have it: the colour "terracotta" is "Terrakotta" in German
    const options = { color: { label: "Farbe", values: { terracotta: "Terrakotta" } }, size: { label: "Größe", values: { "20 cm": "20 cm", "30 cm": "30 cm" } } };
    await db
      .update(translations)
      .set({ value: JSON.stringify(options) })
      .where(and(eq(translations.productId, planter.id), eq(translations.locale, "de"), eq(translations.field, "options")));
    asked.length = 0;

    await db.update(products).set({ tags: ["terracotta", "planter"] }).where(eq(products.id, planter.id));
    await noteEnglishChange(db, planter.id);
    await enqueuePendingTranslations(db, boss, { productIds: [planter.id] });
    await runTranslations();
    expect(translateCalls().map(fieldsAsked)).toEqual([[["tags"]], [["tags"]]]);
    const german = (await productTranslations(db, planter.id)).languages.find((l) => l.locale === "de")!;
    // The mock AI writes "terracotta de": the saved colour wins, the other tag is the AI's
    expect(JSON.parse(german.fields.tags.value)).toEqual(["terrakotta", "planter de"]);
  });

  it("keeps the merchant's own translation, flags it out of date when the English changes, and lets them confirm or drop it", async () => {
    await importSheet();
    await runTranslations();
    const planter = await productByTitle("Hand-thrown Terracotta Planter");

    expect(await writeTranslation(db, planter.id, "de", "title", "Handgedrehter Terrakotta-Übertopf")).toMatchObject({ warnings: [] });
    asked.length = 0;
    await changeEnglishTitle(planter.id, "Large Terracotta Planter");
    await runTranslations();
    // French gets the new title; German keeps the merchant's
    expect(translateCalls().map((r) => (r.input as TranslateInput).locale)).toEqual(["fr"]);
    let german = (await productTranslations(db, planter.id)).languages.find((l) => l.locale === "de")!;
    expect(german.fields.title).toMatchObject({ value: "Handgedrehter Terrakotta-Übertopf", writtenBy: "merchant", outOfDate: true });
    expect(german.shown).toMatchObject({ title: "Handgedrehter Terrakotta-Übertopf", outOfDate: ["title"] });
    expect((await translationCoverage(db)).languages.find((l) => l.locale === "de")).toMatchObject({ merchantFixes: 1, outOfDate: 1 });

    await confirmTranslation(db, planter.id, "de", "title");
    german = (await productTranslations(db, planter.id)).languages.find((l) => l.locale === "de")!;
    expect(german.fields.title.outOfDate).toBe(false);

    await revertToAi(db, boss, planter.id, "de", "title");
    await runTranslations();
    german = (await productTranslations(db, planter.id)).languages.find((l) => l.locale === "de")!;
    expect(german.fields.title).toMatchObject({ value: "Large Terracotta Planter [DE]", writtenBy: "ai" });
  });

  it("keeps a translation that fails a check away from shoppers, with the reason, after asking again", async () => {
    await importSheet();
    // The AI invents claims while translating: "frostfest und spülmaschinenfest"
    process.env.MOCK_AI_MODE = "invent";
    await runTranslations();

    const planter = await productByTitle("Hand-thrown Terracotta Planter");
    const german = (await productTranslations(db, planter.id)).languages.find((l) => l.locale === "de")!;
    expect(german.fields.description_html.issue).toBe("It claims frost-proof, dishwasher-safe, which the English doesn't");
    expect(german.shown.sources.description_html).toBe("english");
    expect(german.shown.descriptionHtml).toBe(planter.descriptionHtml);
    // It was asked again, on the stronger model, with the problems spelled out
    expect(translateCalls().some((r) => r.tier === "strong" && r.system.includes("description_html: it claims frost-proof"))).toBe(true);
    expect((await translationCoverage(db)).languages.find((l) => l.locale === "de")!.withProblems).toBeGreaterThan(0);
  });

  it("notices a translation left in English", async () => {
    await importSheet();
    process.env.MOCK_AI_MODE = "notranslate";
    await runTranslations();
    const planter = await productByTitle("Hand-thrown Terracotta Planter");
    const french = (await productTranslations(db, planter.id)).languages.find((l) => l.locale === "fr")!;
    expect(french.fields.description_html.issue).toBe("It's still in English");
    expect(french.fields.title.issue).toBe("It's still in English");
  });

  it("translates only the languages switched on, and fills in a language when it's switched on", async () => {
    await setShopLanguages(db, false);
    await setCountryEnabled(db, boss, "AT", true);
    const id = await importSheet();
    await runTranslations();
    expect(await getImportSummary(db, id)).toMatchObject({ status: "done", translations: { de: { done: 12 }, fr: { done: 0, pending: 0 } } });

    const switched = await setCountryEnabled(db, boss, "BE", true);
    expect(switched.languagesSwitchedOn).toEqual(["fr"]);
    await runTranslations();
    expect((await translationCoverage(db)).languages.find((l) => l.locale === "fr")).toMatchObject({ done: 12, coverage: 100 });

    // Off and on again: everything is still translated, so no AI call
    asked.length = 0;
    await setCountryEnabled(db, boss, "BE", false);
    await setCountryEnabled(db, boss, "BE", true);
    await runTranslations();
    expect(translateCalls()).toEqual([]);
    expect(await setCountryEnabled(db, boss, "XX", true).catch((e: LanguageSettingError) => e.status)).toBe(404);
  });

  it("marks translations failed when the AI refuses, still finishes the import, and can try again", async () => {
    provider = {
      ...mockProvider,
      generate: (request) => (request.purpose === "translate" ? Promise.reject(new AiPermanentError("API key not valid")) : mockProvider.generate(request)),
    };
    const id = await importSheet();
    await runTranslations();
    expect(await getImportSummary(db, id)).toMatchObject({ status: "done", translations: { de: { failed: 12 } } });
    const [state] = await db.select().from(translationState).limit(1);
    expect(state).toMatchObject({ status: "failed", error: "The AI provider refused the request: API key not valid" });

    provider = mockProvider;
    await retryFailed(db, boss);
    await runTranslations();
    expect((await getImportSummary(db, id))!.translations).toMatchObject({ de: { done: 12, failed: 0 }, fr: { done: 12, failed: 0 } });
  });
});
