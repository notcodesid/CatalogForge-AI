"use client";

import { useEffect, useState } from "react";
import { getJson, postJson } from "../api";
import { LANGUAGE_NAMES } from "../statuses";
import { Badge, buttonClasses, focusClasses, Skeleton } from "../ui";
import { type EnglishFields, errorMessage, type ProductTranslations, sendJson, type TranslatedField, type TranslationField } from "./api";
import { decodeTranslation, FIELD_LABEL, humanize, tagsFromText, tagsToText } from "./view";

type Language = ProductTranslations["languages"][number];
type Attributes = Record<string, { label: string; value: string }>;
type Options = Record<string, { label: string; values: Record<string, string> }>;

const FIELDS: TranslatedField[] = ["title", "description_html", "tags", "attributes", "options"];
const COUNTRIES: Record<string, string> = { de: "Germany and Austria", fr: "France" };

// The product's translations, one language at a time: what shoppers there see, and field by field the English
// next to its translation, who wrote it, and what's wrong with it. The merchant's own translation always wins
export function TranslationsPanel({ productId, version }: { productId: string; version: string }) {
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState<{ data: ProductTranslations } | { error: string } | null>(null);
  const [locale, setLocale] = useState("de");

  useEffect(() => {
    const controller = new AbortController();
    getJson<ProductTranslations>(`/api/products/${productId}/translations`, controller.signal)
      .then((data) => setLoaded({ data }))
      .catch((err) => {
        if (!controller.signal.aborted) setLoaded({ error: errorMessage(err) });
      });
    return () => controller.abort();
  }, [productId, version, nonce]);

  const data = loaded && "data" in loaded ? loaded.data : null;
  // A translation on its way: look again every few seconds until it's there
  const waiting = data?.languages.some((l) => l.enabled && l.status === "pending");
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setNonce((n) => n + 1), 3000);
    return () => clearTimeout(timer);
  }, [waiting, data]);

  const reload = () => setNonce((n) => n + 1);
  const current = data?.languages.find((l) => l.locale === locale) ?? data?.languages[0];

  return (
    <section aria-labelledby="translations-heading" className="space-y-4 rounded-lg border border-border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="translations-heading" className="text-base font-semibold">
          Translations
        </h2>
        {data && (
          <div
            role="tablist"
            aria-label="Language"
            className="flex gap-1"
            // The usual tabs keys: arrows move between languages, Home and End go to the first and last
            onKeyDown={(e) => {
              const i = data.languages.findIndex((l) => l.locale === current?.locale);
              const n = data.languages.length;
              const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
              if (to === undefined) return;
              e.preventDefault();
              setLocale(data.languages[to].locale);
              document.getElementById(`tab-${data.languages[to].locale}`)?.focus();
            }}
          >
            {data.languages.map((l) => (
              <button
                key={l.locale}
                type="button"
                role="tab"
                id={`tab-${l.locale}`}
                aria-selected={current?.locale === l.locale}
                aria-controls={`panel-${l.locale}`}
                tabIndex={current?.locale === l.locale ? 0 : -1}
                onClick={() => setLocale(l.locale)}
                className={buttonClasses(current?.locale === l.locale ? "primary" : "secondary", "sm")}
              >
                {LANGUAGE_NAMES[l.locale] ?? l.locale}
              </button>
            ))}
          </div>
        )}
      </div>

      {!loaded && <Skeleton className="h-40" />}
      {loaded && "error" in loaded && (
        <p role="alert" className="text-sm text-danger">
          Couldn&apos;t load the translations: {loaded.error}
        </p>
      )}
      {data && current && (
        <div role="tabpanel" id={`panel-${current.locale}`} aria-labelledby={`tab-${current.locale}`} className="space-y-4">
          <LanguageStatus productId={productId} language={current} onRetried={reload} />
          <Shown language={current} />
          <ul className="divide-y divide-border rounded-md border border-border">
            {FIELDS.filter((f) => data.english[f] !== undefined).map((field) => (
              <FieldRow
                key={`${current.locale}-${field}`}
                productId={productId}
                locale={current.locale}
                field={field}
                english={data.english}
                translation={current.fields[field]}
                pending={current.status === "pending"}
                onChanged={reload}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function LanguageStatus({ productId, language, onRetried }: { productId: string; language: Language; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/translations/retry", { productIds: [productId] });
      onRetried();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {language.enabled ? (
        <span className="text-muted-foreground">Shown to shoppers in {COUNTRIES[language.locale] ?? language.locale.toUpperCase()}</span>
      ) : (
        <span className="text-muted-foreground">No country is set to see this language right now, so shoppers get English</span>
      )}
      {language.status === "done" && <Badge tone="success">Translated</Badge>}
      {language.status === "pending" && <Badge tone="info">Translating…</Badge>}
      {language.status === "failed" && (
        <>
          <Badge tone="danger">Failed</Badge>
          <span className="text-danger">{language.error}</span>
          <button type="button" className={buttonClasses("secondary", "sm")} disabled={busy} onClick={retry}>
            Try again
          </button>
        </>
      )}
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}

// What a shopper in this language reads: the merchant's translation, else the AI's (current and checked), else
// the English
function Shown({ language }: { language: Language }) {
  const english = Object.entries(language.shown.sources).filter(([, source]) => source === "english").map(([field]) => FIELD_LABEL[field as TranslatedField]);
  return (
    <div className="space-y-2 rounded-md bg-muted p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What shoppers see</p>
      <p className="font-medium" lang={language.locale}>
        {language.shown.title}
      </p>
      <div
        lang={language.locale}
        className="space-y-2 text-sm [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"
        dangerouslySetInnerHTML={{ __html: language.shown.descriptionHtml }}
      />
      {english.length > 0 && <p className="text-xs text-muted-foreground">In English for now: {english.join(", ")}</p>}
    </div>
  );
}

function FieldRow({
  productId,
  locale,
  field,
  english,
  translation,
  pending,
  onChanged,
}: {
  productId: string;
  locale: string;
  field: TranslatedField;
  english: EnglishFields;
  translation: TranslationField | undefined;
  pending: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "danger" | "warning"; lines: string[] } | null>(null);
  const url = `/api/products/${productId}/translations/${locale}/${field}`;

  const act = async (work: () => Promise<{ warnings?: string[] } | unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = (await work()) as { warnings?: string[] } | null;
      if (result?.warnings?.length) setMessage({ tone: "warning", lines: ["Saved. Our checks noticed:", ...result.warnings] });
      setEditing(false);
      onChanged();
    } catch (err) {
      setMessage({ tone: "danger", lines: [errorMessage(err)] });
    } finally {
      setBusy(false);
    }
  };

  const value = translation ? decodeTranslation(field, translation.value) : null;
  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{FIELD_LABEL[field]}</h3>
        {translation?.writtenBy === "merchant" && <Badge tone="info">Your translation</Badge>}
        {translation?.writtenBy === "ai" && <Badge tone="neutral">AI</Badge>}
        {translation?.outOfDate && <Badge tone="warning">Out of date</Badge>}
        {translation?.issue && <Badge tone="danger">Shown in English</Badge>}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">English</p>
          <Value field={field} english={english} value={english[field]} lang="en" />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{LANGUAGE_NAMES[locale] ?? locale}</p>
          {translation ? (
            <Value field={field} english={english} value={value} lang={locale} translated />
          ) : (
            <p className="text-sm text-muted-foreground">{pending ? "On its way…" : "Not translated. Shoppers see the English."}</p>
          )}
        </div>
      </div>

      {translation?.issue && (
        <p className="rounded-md border border-danger/30 bg-danger-soft p-2 text-sm">
          The AI&apos;s translation failed a check, so shoppers see the English: {translation.issue}
        </p>
      )}
      {translation?.outOfDate && <p className="text-sm text-warning">The English changed since you wrote this. It&apos;s still shown: check it&apos;s still right.</p>}
      {translation?.writtenBy === "ai" && !translation.upToDate && !translation.issue && (
        <p className="text-sm text-muted-foreground">The English changed: shoppers see the English until the new translation is in.</p>
      )}

      {message && (
        <ul role={message.tone === "danger" ? "alert" : "status"} className={`space-y-0.5 text-sm ${message.tone === "danger" ? "text-danger" : "text-warning"}`}>
          {message.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}

      {editing ? (
        <TranslationEditor
          field={field}
          english={english}
          initial={value}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(next) => act(() => sendJson("PUT", url, { value: next }))}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClasses("secondary", "sm")} disabled={busy} onClick={() => setEditing(true)}>
            {translation?.writtenBy === "merchant" ? "Edit" : "Write it yourself"}
          </button>
          {translation?.outOfDate && (
            <button type="button" className={buttonClasses("secondary", "sm")} disabled={busy} onClick={() => act(() => sendJson("PUT", url, { confirm: true }))}>
              It&apos;s still right
            </button>
          )}
          {translation?.writtenBy === "merchant" && (
            <button type="button" className={buttonClasses("ghost", "sm")} disabled={busy} onClick={() => act(() => sendJson("DELETE", url))}>
              Use the AI&apos;s translation again
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// One field's value, read the way a shopper would
function Value({ field, english, value, lang, translated = false }: { field: TranslatedField; english: EnglishFields; value: unknown; lang: string; translated?: boolean }) {
  if (value === null || value === undefined) return <p className="text-sm text-muted-foreground">—</p>;
  if (field === "title") return <p lang={lang} className="text-sm">{String(value)}</p>;
  if (field === "description_html") {
    return (
      <div
        lang={lang}
        className="space-y-2 text-sm [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"
        // Cleaned on the server: only p, ul, ol, li, strong, em
        dangerouslySetInnerHTML={{ __html: String(value) }}
      />
    );
  }
  if (field === "tags") {
    return (
      <ul lang={lang} className="flex flex-wrap gap-1.5">
        {(value as string[]).map((tag) => (
          <li key={tag}>
            <Badge tone="neutral">{tag}</Badge>
          </li>
        ))}
      </ul>
    );
  }
  if (field === "attributes") {
    const entries = Object.keys(english.attributes ?? {});
    return (
      <dl lang={lang} className="space-y-0.5 text-sm">
        {entries.map((key) => {
          const label = translated ? (value as Attributes)[key]?.label : humanize(key);
          const text = translated ? (value as Attributes)[key]?.value : (value as Record<string, string>)[key];
          return (
            <div key={key} className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{label ?? key}:</dt>
              <dd>{text ?? "—"}</dd>
            </div>
          );
        })}
      </dl>
    );
  }
  const names = Object.keys(english.options ?? {});
  return (
    <dl lang={lang} className="space-y-0.5 text-sm">
      {names.map((name) => {
        const englishValues = english.options![name];
        const label = translated ? (value as Options)[name]?.label : humanize(name);
        const values = translated ? englishValues.map((v) => (value as Options)[name]?.values?.[v] ?? v) : englishValues;
        return (
          <div key={name} className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">{label ?? name}:</dt>
            <dd>{values.join(", ")}</dd>
          </div>
        );
      })}
    </dl>
  );
}

const inputClasses = `w-full rounded-md border border-border bg-background px-3 py-2 text-sm ${focusClasses}`;

// Writes a field's translation by hand. Starts from the current translation (or the English), in the field's shape
function TranslationEditor({
  field,
  english,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  field: TranslatedField;
  english: EnglishFields;
  initial: unknown;
  busy: boolean;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(() => {
    if (field === "title") return String(initial ?? english.title ?? "");
    if (field === "description_html") return String(initial ?? english.description_html ?? "");
    if (field === "tags") return tagsToText((initial as string[] | null) ?? english.tags ?? []);
    return "";
  });
  const [attributes, setAttributes] = useState<Attributes>(() =>
    Object.fromEntries(
      Object.entries(english.attributes ?? {}).map(([key, value]) => [key, (initial as Attributes | null)?.[key] ?? { label: humanize(key), value }]),
    ),
  );
  const [options, setOptions] = useState<Options>(() =>
    Object.fromEntries(
      Object.entries(english.options ?? {}).map(([name, values]) => {
        const current = (initial as Options | null)?.[name];
        return [name, { label: current?.label ?? humanize(name), values: Object.fromEntries(values.map((v) => [v, current?.values?.[v] ?? v])) }];
      }),
    ),
  );

  const value = () => {
    if (field === "tags") return tagsFromText(text);
    if (field === "attributes") return attributes;
    if (field === "options") return options;
    return text;
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value());
      }}
    >
      {field === "title" && <input aria-label="Translated title" required maxLength={200} value={text} onChange={(e) => setText(e.target.value)} className={inputClasses} />}
      {field === "description_html" && (
        <textarea aria-label="Translated description (HTML)" required rows={6} value={text} onChange={(e) => setText(e.target.value)} className={`${inputClasses} font-mono text-xs`} />
      )}
      {field === "tags" && <input aria-label="Translated tags, separated by commas" required value={text} onChange={(e) => setText(e.target.value)} className={inputClasses} />}
      {field === "attributes" &&
        Object.entries(attributes).map(([key, entry]) => (
          <div key={key} className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr] sm:items-center">
            <span className="text-xs text-muted-foreground">{key}</span>
            <input
              aria-label={`Name shown for ${key}`}
              required
              value={entry.label}
              onChange={(e) => setAttributes((a) => ({ ...a, [key]: { ...a[key], label: e.target.value } }))}
              className={inputClasses}
            />
            <input
              aria-label={`Value of ${key}`}
              required
              value={entry.value}
              onChange={(e) => setAttributes((a) => ({ ...a, [key]: { ...a[key], value: e.target.value } }))}
              className={inputClasses}
            />
          </div>
        ))}
      {field === "options" &&
        Object.entries(options).map(([name, entry]) => (
          <fieldset key={name} className="space-y-2 rounded-md border border-border p-2">
            <legend className="px-1 text-xs text-muted-foreground">{name}</legend>
            <input
              aria-label={`Name shown for the option ${name}`}
              required
              value={entry.label}
              onChange={(e) => setOptions((o) => ({ ...o, [name]: { ...o[name], label: e.target.value } }))}
              className={inputClasses}
            />
            {Object.entries(entry.values).map(([englishValue, translatedValue]) => (
              <label key={englishValue} className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr] sm:items-center">
                <span className="text-muted-foreground">{englishValue}</span>
                <input
                  required
                  value={translatedValue}
                  onChange={(e) => setOptions((o) => ({ ...o, [name]: { ...o[name], values: { ...o[name].values, [englishValue]: e.target.value } } }))}
                  className={inputClasses}
                />
              </label>
            ))}
          </fieldset>
        ))}
      <div className="flex gap-2">
        <button type="submit" className={buttonClasses("primary", "sm")} disabled={busy}>
          {busy ? "Saving…" : "Save translation"}
        </button>
        <button type="button" className={buttonClasses("ghost", "sm")} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
