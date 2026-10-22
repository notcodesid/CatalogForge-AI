import type { Locale } from "@/server/translations/fields";

// Which country a shopper is in decides the language they see (see translations/languages.ts). In this order:
// the country switcher (?country= in the link, then the cookie it leaves behind), then the country the hosting
// platform worked out from the IP address. Nothing at all: English
export const COUNTRY_COOKIE = "shop-country";
// "Everywhere else" in the switcher: no translation, English
export const OTHER_COUNTRY = "XX";

export type Language = Locale | "en";
export type ShopCountry = { country: string; name: string; language: string; enabled: boolean };

// "de", " De " -> "DE". Anything that isn't two letters (Cloudflare's "T1" for Tor, junk in a link) is ignored
export function normalizeCountry(value: string | string[] | null | undefined): string | null {
  const code = (Array.isArray(value) ? value[0] : value)?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}

type HeaderReader = { get(name: string): string | null };

export function pickCountry(sources: { query?: string | string[] | null; cookie?: string | null; headers?: HeaderReader | null }): {
  country: string | null;
  // The country came from the link: links on the page carry it on, so the choice holds before the cookie is set
  fromQuery: boolean;
} {
  const fromQuery = normalizeCountry(sources.query);
  if (fromQuery) return { country: fromQuery, fromQuery: true };
  const detected =
    normalizeCountry(sources.cookie) ?? normalizeCountry(sources.headers?.get("x-vercel-ip-country")) ?? normalizeCountry(sources.headers?.get("cf-ipcountry"));
  return { country: detected, fromQuery: false };
}

// A country's language when it's switched on, English otherwise. Read from the cached list of countries, so a page
// doesn't ask the database every time
export function languageFor(country: string | null, countries: ShopCountry[]): Language {
  const row = country ? countries.find((c) => c.country === country) : undefined;
  return row?.enabled && (row.language === "de" || row.language === "fr") ? row.language : "en";
}

// The locale for numbers and prices: German in Austria writes prices like Austrians do ("de-AT")
export function intlLocale(language: Language, country: string | null): string {
  const fallback = language === "en" ? "en-GB" : language;
  if (!country || country === OTHER_COUNTRY) return fallback;
  const tag = `${language}-${country}`;
  return Intl.NumberFormat.supportedLocalesOf([tag]).length ? tag : fallback;
}

// Prices are stored as integer cents (see pipeline/clean/price.ts), whatever the currency
export function formatPrice(cents: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
