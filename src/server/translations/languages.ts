import { asc, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { countryLanguages } from "@/server/db/schema";
import { isLocale, type Locale } from "./fields";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const COUNTRY_NAMES: Record<string, string> = {
  DE: "Germany",
  AT: "Austria",
  CH: "Switzerland",
  LI: "Liechtenstein",
  FR: "France",
  BE: "Belgium",
  LU: "Luxembourg",
  MC: "Monaco",
};

// The languages the shop shows somewhere. Only these are translated: a language no country uses costs nothing
export async function enabledLocales(db: DbOrTx): Promise<Locale[]> {
  const rows = await db.selectDistinct({ language: countryLanguages.language }).from(countryLanguages).where(eq(countryLanguages.enabled, true));
  return rows.map((r) => r.language).filter(isLocale).sort();
}

export async function listCountries(db: DbOrTx) {
  const rows = await db.select().from(countryLanguages).orderBy(asc(countryLanguages.language), asc(countryLanguages.country));
  return rows.map((r) => ({ country: r.country, name: COUNTRY_NAMES[r.country] ?? r.country, language: r.language, enabled: r.enabled }));
}
