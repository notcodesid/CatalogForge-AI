"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, getJson, postJson, sendJson } from "../api";
import { Badge, ErrorState, linkClasses, ProgressBar, Skeleton } from "../ui";

type Country = { country: string; name: string; language: string; enabled: boolean };
type Coverage = {
  products: number;
  languages: { locale: string; enabled: boolean; done: number; pending: number; failed: number; withProblems: number; merchantFixes: number; outOfDate: number; translated: number; coverage: number }[];
};
type SwitchResult = { countries: Country[]; languagesSwitchedOn: string[]; languagesSwitchedOff: string[] };

const LANGUAGE_NAMES: Record<string, string> = { de: "German", fr: "French" };
const languageName = (locale: string) => LANGUAGE_NAMES[locale] ?? locale;
const plural = (n: number, word: string) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

// Refresh quickly while products are still being translated, slowly otherwise
const BUSY_MS = 3_000;
const IDLE_MS = 30_000;

// Which language each country's shoppers see. Switching a country on is all it takes: if no country showed its
// language yet, the catalog is translated into it in the background (products already translated cost nothing).
// Every country that isn't switched on sees English
export function LanguagesSettings() {
  const [countries, setCountries] = useState<Country[] | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const [settings, cov] = await Promise.all([
      getJson<{ countries: Country[] }>("/api/settings/languages", signal),
      getJson<Coverage>("/api/translations", signal),
    ]);
    setCountries(settings.countries);
    setCoverage(cov);
    setError(null);
    return cov;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const cov = await load(controller.signal);
        const busy = cov.languages.some((l) => l.enabled && l.pending > 0);
        if (!document.hidden) timer = setTimeout(tick, busy ? BUSY_MS : IDLE_MS);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : "Can't reach the server. Check your connection");
      }
    };
    void tick();
    const onVisible = () => !document.hidden && void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, nonce]);

  async function toggle(country: Country) {
    setSaving(country.country);
    setNotice(null);
    try {
      const result = await sendJson<SwitchResult>("PUT", `/api/settings/languages/${country.country}`, { enabled: !country.enabled });
      setCountries(result.countries);
      const on = result.languagesSwitchedOn.map(languageName);
      const off = result.languagesSwitchedOff.map(languageName);
      setNotice(
        on.length
          ? `${on.join(" and ")} is now shown in ${country.name}. Products not yet in ${on.join(" or ")} are being translated in the background.`
          : off.length
            ? `No country shows ${off.join(" or ")} now. Its translations are kept; new products won't be translated into it until a country is switched back on.`
            : `${country.name} now sees ${country.enabled ? "English" : languageName(country.language)}.`,
      );
      setNonce((n) => n + 1);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Something went wrong. Try again");
    } finally {
      setSaving(null);
    }
  }

  async function retry() {
    try {
      await postJson("/api/translations/retry");
      setNonce((n) => n + 1);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Something went wrong. Try again");
    }
  }

  if (error && !countries) return <ErrorState title="Couldn't load the language settings" message={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (!countries || !coverage) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const locales = [...new Set(countries.map((c) => c.language))];
  return (
    <div className="space-y-4">
      {notice && (
        <p role="status" className="rounded-lg border border-border bg-card p-3 text-sm">
          {notice}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {locales.map((locale) => {
          const stats = coverage.languages.find((l) => l.locale === locale);
          const shown = countries.some((c) => c.language === locale && c.enabled);
          const rest = stats ? Math.max(0, coverage.products - stats.translated - stats.withProblems - stats.pending - stats.failed) : 0;
          return (
            <section key={locale} aria-labelledby={`lang-${locale}`} className="space-y-4 rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 id={`lang-${locale}`} className="text-base font-semibold">
                  {languageName(locale)}
                </h2>
                <Badge tone={shown ? "success" : "neutral"}>{shown ? "Shown to shoppers" : "Switched off"}</Badge>
              </div>

              <ul className="divide-y divide-border">
                {countries
                  .filter((c) => c.language === locale)
                  .map((c) => (
                    <li key={c.country} className="flex min-h-12 items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {c.name} <span className="text-muted-foreground">({c.country})</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {c.enabled ? `Sees ${languageName(locale)}. ` : "Sees English. "}
                          <a href={`/shop?country=${c.country}`} target="_blank" rel="noreferrer" className={linkClasses}>
                            Preview the shop
                          </a>
                        </p>
                      </div>
                      <label className="relative inline-flex shrink-0 cursor-pointer items-center">
                        <input
                          type="checkbox"
                          role="switch"
                          className="peer sr-only"
                          checked={c.enabled}
                          disabled={saving !== null}
                          onChange={() => void toggle(c)}
                          aria-label={`Show ${languageName(locale)} in ${c.name}`}
                        />
                        <span className="h-6 w-11 rounded-full bg-muted transition-colors peer-checked:bg-success peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:opacity-50" />
                        <span className="absolute left-0.5 size-5 rounded-full bg-card shadow transition-transform peer-checked:translate-x-5 motion-reduce:transition-none" />
                      </label>
                    </li>
                  ))}
              </ul>

              {stats && (
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium">{stats.coverage}% of the catalog translated</span>
                    <span className="text-muted-foreground">
                      {stats.translated.toLocaleString("en")} of {coverage.products.toLocaleString("en")}
                    </span>
                  </div>
                  <ProgressBar
                    label={`${languageName(locale)}: ${stats.translated} translated, ${stats.withProblems} with a field shown in English, ${stats.pending} being translated, ${stats.failed} failed`}
                    segments={[
                      { value: stats.translated, tone: "success" },
                      { value: stats.withProblems, tone: "warning" },
                      { value: stats.pending, tone: "info" },
                      { value: stats.failed, tone: "danger" },
                      { value: rest, tone: "neutral" },
                    ]}
                  />
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {stats.pending > 0 && <li>Translating {plural(stats.pending, "product")}…</li>}
                    {stats.withProblems > 0 && <li>{plural(stats.withProblems, "product")} with a field shoppers see in English (a translation that failed our checks)</li>}
                    {stats.failed > 0 && (
                      <li>
                        {plural(stats.failed, "product")} couldn&apos;t be translated.{" "}
                        <button type="button" onClick={() => void retry()} className={linkClasses}>
                          Try again
                        </button>
                      </li>
                    )}
                    {stats.merchantFixes > 0 && (
                      <li>
                        {stats.merchantFixes.toLocaleString("en")} {stats.merchantFixes === 1 ? "translation" : "translations"} written by you
                        {stats.outOfDate > 0 && `, ${stats.outOfDate.toLocaleString("en")} out of date (the English changed since)`}
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </section>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground">Shoppers from every other country see English.</p>
    </div>
  );
}
