import { cookies, headers } from "next/headers";
import { shopCountries } from "@/server/storefront/cached";
import { COUNTRY_COOKIE, intlLocale, languageFor, pickCountry } from "@/server/storefront/country";
import { shopText } from "@/server/storefront/text";

export type SearchParams = Record<string, string | string[] | undefined>;

// Who's shopping, worked out once per request: their country (switcher link, its cookie, or what the platform
// detected), the language that country gets, how to write prices, and the storefront's own words
export async function shopperContext(searchParams: SearchParams) {
  const [cookieStore, headerList, countries] = await Promise.all([cookies(), headers(), shopCountries()]);
  const { country, fromQuery } = pickCountry({ query: searchParams.country, cookie: cookieStore.get(COUNTRY_COOKIE)?.value, headers: headerList });
  const language = languageFor(country, countries);
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const protocol = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return {
    country,
    // Carried on in links while the choice came from a link, so it holds before the cookie is saved
    countryParam: fromQuery ? country : null,
    language,
    locale: intlLocale(language, country),
    countries,
    text: shopText(language),
    baseUrl: `${protocol}://${host}`,
  };
}

export type Shopper = Awaited<ReturnType<typeof shopperContext>>;

// A link inside the shop, keeping the country the shopper picked
export function shopHref(path: string, shopper: Pick<Shopper, "countryParam">, params: Record<string, string | number | null | undefined> = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, country: shopper.countryParam })) {
    if (value !== null && value !== undefined && value !== "") query.set(key, String(value));
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}
