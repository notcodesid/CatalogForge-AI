import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/server/db/client";
import { countryLanguages } from "@/server/db/schema";
import { enabledLocales, listCountries } from "./languages";
import { backfillLocale, dropPending, enqueuePendingTranslations } from "./state";

export class LanguageSettingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// Switches a country's language on or off. A language that's now shown somewhere for the first time gets every
// product translated (products already translated cost no AI call). A language no country shows any more
// stops being translated; what's done is kept for when it's switched on again
export async function setCountryEnabled(db: Db, boss: PgBoss, country: string, enabled: boolean) {
  const code = country.toUpperCase();
  const changed = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(countryLanguages).where(eq(countryLanguages.country, code)).for("update");
    if (!row) throw new LanguageSettingError(`${code} isn't in the list of countries`, 404);
    const before = await enabledLocales(tx);
    await tx.update(countryLanguages).set({ enabled }).where(eq(countryLanguages.country, code));
    const after = await enabledLocales(tx);
    const added = after.filter((l) => !before.includes(l));
    const removed = before.filter((l) => !after.includes(l));
    for (const locale of added) await backfillLocale(tx, locale);
    for (const locale of removed) await dropPending(tx, locale);
    return { added, removed };
  });
  if (changed.added.length) await enqueuePendingTranslations(db, boss);
  return { countries: await listCountries(db), languagesSwitchedOn: changed.added, languagesSwitchedOff: changed.removed };
}
