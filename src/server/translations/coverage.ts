import { sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { products, translations, translationState } from "@/server/db/schema";
import { LOCALES } from "./fields";
import { enabledLocales } from "./languages";

type Counts = { done: number; pending: number; failed: number; withProblems: number; merchantFixes: number; outOfDate: number };

// Per language: how many products are translated, still to do, or failed, how many have a field shoppers see in
// English because the AI's translation failed a check, and how many of the merchant's own translations are out
// of date (the English changed since). For one import's products, or the whole catalog
export async function translationCounts(db: Db, importId?: string) {
  const scope = importId ? sql`and p.last_import_id = ${importId}` : sql``;
  const { rows: states } = await db.execute<{ locale: string; status: string; n: number }>(sql`
    select ts.locale, ts.status, count(*)::int as n
    from ${translationState} ts join ${products} p on p.id = ts.product_id
    where p.deleted_at is null ${scope}
    group by ts.locale, ts.status
  `);
  const { rows: fields } = await db.execute<{ locale: string; problems: number; fixes: number; out_of_date: number }>(sql`
    select t.locale,
      count(distinct t.product_id) filter (where t.written_by = 'ai' and t.issue is not null and t.source_hash = p.english_hashes->>t.field)::int as problems,
      count(*) filter (where t.written_by = 'merchant')::int as fixes,
      count(*) filter (where t.written_by = 'merchant' and t.source_hash is distinct from p.english_hashes->>t.field)::int as out_of_date
    from ${translations} t join ${products} p on p.id = t.product_id
    where p.deleted_at is null ${scope}
    group by t.locale
  `);
  const result: Record<string, Counts> = {};
  for (const locale of LOCALES) {
    const n = (status: string) => states.find((s) => s.locale === locale && s.status === status)?.n ?? 0;
    const f = fields.find((r) => r.locale === locale);
    result[locale] = { done: n("done"), pending: n("pending"), failed: n("failed"), withProblems: f?.problems ?? 0, merchantFixes: f?.fixes ?? 0, outOfDate: f?.out_of_date ?? 0 };
  }
  return result;
}

// For the metrics tab: coverage of the whole catalog per language the shop shows
export async function translationCoverage(db: Db) {
  const [{ total }] = (await db.execute<{ total: number }>(sql`select count(*)::int as total from ${products} where deleted_at is null`)).rows;
  const enabled = await enabledLocales(db);
  const counts = await translationCounts(db);
  return {
    products: total,
    languages: LOCALES.map((locale) => {
      const c = counts[locale];
      // Fully translated: done, and every field shown in the language (no field fell back to English)
      const translated = Math.max(0, c.done - c.withProblems);
      return { locale, enabled: enabled.includes(locale), ...c, translated, coverage: total ? Math.round((translated / total) * 1000) / 10 : 0 };
    }),
  };
}
