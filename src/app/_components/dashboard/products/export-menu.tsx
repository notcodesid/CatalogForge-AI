"use client";

import { useEffect, useRef, useState } from "react";
import { LANGUAGE_NAMES } from "../statuses";
import { buttonClasses, focusClasses } from "../ui";

const FORMATS = [
  { value: "csv", label: "CSV", hint: "One row per variant, for spreadsheets" },
  { value: "json", label: "JSON", hint: "Every product with its variants, claims, photos and translations" },
  { value: "shopify", label: "Shopify CSV", hint: "Ready to import into a Shopify store" },
] as const;

const STATUSES = [
  { value: "approved", label: "Approved (what's in the shop)" },
  { value: "ready", label: "Ready to approve" },
  { value: "all", label: "Everything" },
] as const;

const LANGUAGES = ["en", "de", "fr"] as const;

// The export, as a download link: the server streams the file a page at a time, so even 10,000 products don't
// wait in the browser. Deleted products are never in it
export function ExportMenu() {
  const [format, setFormat] = useState<(typeof FORMATS)[number]["value"]>("csv");
  const [status, setStatus] = useState<(typeof STATUSES)[number]["value"]>("approved");
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number]>("en");
  const href = `/api/export?${new URLSearchParams({ format, status, language })}`;

  // Closes like a menu: Escape (back to the button), or a click anywhere else on the page
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener("click", closeOutside);
    return () => document.removeEventListener("click", closeOutside);
  }, []);

  return (
    <details
      ref={ref}
      className="group relative"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !ref.current?.open) return;
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }}
    >
      <summary className={`${buttonClasses("secondary")} list-none [&::-webkit-details-marker]:hidden`}>
        Export
        <span aria-hidden className="text-xs transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-[min(22rem,calc(100vw-2rem))] space-y-4 rounded-lg border border-border bg-card p-4 shadow-lg">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Format</legend>
          {FORMATS.map((f) => (
            <label key={f.value} className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="radio" name="export-format" value={f.value} checked={format === f.value} onChange={() => setFormat(f.value)} className={`mt-1 ${focusClasses}`} />
              <span>
                <span className="font-medium">{f.label}</span>
                <span className="block text-xs text-muted-foreground">{f.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Products</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className={`min-h-10 w-full rounded-md border border-border bg-card px-2 text-sm sm:min-h-9 ${focusClasses}`}
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Language</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as typeof language)}
              className={`min-h-10 w-full rounded-md border border-border bg-card px-2 text-sm sm:min-h-9 ${focusClasses}`}
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l === "en" ? "English" : LANGUAGE_NAMES[l]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <a href={href} download className={`${buttonClasses("primary")} w-full`}>
          Download
        </a>
        <p className="text-xs text-muted-foreground">
          In German or French, each field is what shoppers there see: your own translation, else the AI&apos;s, else the English.
        </p>
      </div>
    </details>
  );
}
