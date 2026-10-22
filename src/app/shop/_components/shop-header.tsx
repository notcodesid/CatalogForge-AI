import Link from "next/link";
import { OTHER_COUNTRY } from "@/server/storefront/country";
import type { Shopper } from "../_lib/shopper";
import { shopHref } from "../_lib/shopper";

const LANGUAGE_NAMES: Record<string, string> = { de: "Deutsch", fr: "Français", en: "English" };

// "DE" -> the German flag, built from the letters so no flag has to be stored anywhere
function flag(country: string) {
  if (country === OTHER_COUNTRY) return String.fromCodePoint(0x1f30d);
  return String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// The shop's top bar: name, and the country switcher. Each country links to this same page with ?country=, and
// says which language it gets (English while its language is switched off)
export function ShopHeader({ shopper, switchHref }: { shopper: Shopper; switchHref: (country: string) => string }) {
  const regionNames = new Intl.DisplayNames([shopper.locale, "en"], { type: "region" });
  const name = (country: string) => (country === OTHER_COUNTRY ? shopper.text.otherCountries : (regionNames.of(country) ?? country));
  const options = [...shopper.countries.map((c) => ({ country: c.country, language: c.enabled ? c.language : "en" })), { country: OTHER_COUNTRY, language: "en" }];
  const current = options.find((o) => o.country === shopper.country) ?? (shopper.country ? { country: shopper.country, language: shopper.language } : null);

  return (
    <header className="sticky top-0 z-10 border-b border-stone-200 bg-white/90 backdrop-blur dark:border-stone-800 dark:bg-stone-950/90">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href={shopHref("/shop", shopper)} className="text-base font-semibold tracking-tight sm:text-lg">
          {shopper.text.shopName}
        </Link>
        <details className="relative">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900">
            <span aria-hidden>{current ? flag(current.country) : flag(OTHER_COUNTRY)}</span>
            <span className="hidden sm:inline">{current ? name(current.country) : shopper.text.country}</span>
            <span className="text-stone-500">{LANGUAGE_NAMES[shopper.language]}</span>
          </summary>
          <ul className="absolute right-0 mt-2 w-64 overflow-hidden rounded-xl border border-stone-200 bg-white py-1 text-sm shadow-lg dark:border-stone-800 dark:bg-stone-900">
            {options.map((option) => (
              <li key={option.country}>
                <Link
                  href={switchHref(option.country)}
                  aria-current={option.country === shopper.country ? "true" : undefined}
                  className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-stone-100 aria-[current]:font-semibold dark:hover:bg-stone-800"
                >
                  <span>
                    <span aria-hidden className="mr-2">
                      {flag(option.country)}
                    </span>
                    {name(option.country)}
                  </span>
                  <span className="text-stone-500">{LANGUAGE_NAMES[option.language]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </header>
  );
}
