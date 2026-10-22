"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ApiError, getJson, type ImportSummary, type ParseInfo } from "./api";
import { formatCount } from "./format";
import { ImportCard, ImportCardSkeleton } from "./import-card";
import { PhotosPanel } from "./photos-panel";
import { RowsPanel } from "./rows-panel";
import { ErrorState, linkClasses, Skeleton } from "./ui";

type State = { status: "loading" } | { status: "error"; message: string; notFound: boolean } | { status: "ready"; summary: ImportSummary };

const finished = (s: ImportSummary) => s.status === "done" || s.status === "failed" || s.status === "waiting_for_files";

// The import's summary, kept live: Server-Sent Events while it runs, ordinary requests if the stream keeps
// failing (some proxies don't let it through)
function useLiveSummary(id: string) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const fetchOnce = async () => {
      try {
        const summary = await getJson<ImportSummary>(`/api/imports/${id}`, controller.signal);
        if (!closed) setState({ status: "ready", summary });
        return summary;
      } catch (err) {
        if (closed) return null;
        const notFound = err instanceof ApiError && err.status === 404;
        const message = notFound ? "This import doesn't exist, or it was removed." : err instanceof ApiError ? err.message : "Can't reach the server";
        setState((prev) => (prev.status === "ready" && !notFound ? prev : { status: "error", message, notFound }));
        return null;
      }
    };
    const poll = async () => {
      const summary = await fetchOnce();
      if (!closed && (!summary || !finished(summary))) timer = setTimeout(poll, 2_000);
    };

    void (async () => {
      const first = await fetchOnce();
      if (closed || !first || finished(first)) return;
      if (typeof EventSource === "undefined") return poll();
      source = new EventSource(`/api/imports/${id}/events`);
      let failures = 0;
      source.addEventListener("summary", (e) => {
        failures = 0;
        setState({ status: "ready", summary: JSON.parse((e as MessageEvent<string>).data) as ImportSummary });
      });
      source.addEventListener("end", () => source?.close());
      source.onerror = () => {
        // EventSource reconnects by itself; after a few failures in a row, fall back to plain requests
        if (++failures >= 3) {
          source?.close();
          void poll();
        }
      };
    })();

    return () => {
      closed = true;
      controller.abort();
      source?.close();
      clearTimeout(timer);
    };
  }, [id, nonce]);

  return { state, reload: () => setNonce((n) => n + 1) };
}

const TABS = [
  { key: "rows", label: "Rows" },
  { key: "photos", label: "Photos" },
  { key: "sheet", label: "Sheet" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function ImportDetail({ id }: { id: string }) {
  const { state, reload } = useLiveSummary(id);
  const [tab, setTab] = useState<TabKey>("rows");
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow keys move between tabs, as in any tab list
  const onTabKey = (e: KeyboardEvent, index: number) => {
    const next = e.key === "ArrowRight" ? index + 1 : e.key === "ArrowLeft" ? index - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const target = (next + TABS.length) % TABS.length;
    setTab(TABS[target].key);
    tabRefs.current[target]?.focus();
  };

  return (
    <div className="space-y-6">
      <Link href="/" className={`${linkClasses} text-sm`}>
        ← All imports
      </Link>

      {state.status === "loading" && (
        <div className="space-y-4" aria-busy="true" aria-label="Loading the import">
          <ImportCardSkeleton />
          <Skeleton className="h-64" />
        </div>
      )}
      {state.status === "error" && (
        <ErrorState title={state.notFound ? "Import not found" : "Couldn't load this import"} message={state.message} onRetry={state.notFound ? undefined : reload} />
      )}
      {state.status === "ready" && (
        <>
          <ImportCard imp={state.summary} onChanged={reload} headingLevel={2} showDetailsLink={false} />

          <div>
            <div role="tablist" aria-label="Import details" className="flex gap-1 border-b border-border">
              {TABS.map((t, i) => (
                <button
                  key={t.key}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  id={`${baseId}-tab-${t.key}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  aria-controls={`${baseId}-panel-${t.key}`}
                  tabIndex={tab === t.key ? 0 : -1}
                  onClick={() => setTab(t.key)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className={`-mb-px inline-flex min-h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    tab === t.key ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div id={`${baseId}-panel-${tab}`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`} tabIndex={0} className="pt-4 focus-visible:outline-none">
              {tab === "rows" && <RowsPanel importId={id} counts={state.summary.rows} />}
              {tab === "photos" && <PhotosPanel importId={id} summary={state.summary} />}
              {tab === "sheet" && <SheetPanel info={state.summary.parseInfo} totalRows={state.summary.totalRows} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const FIELD_NAMES: Record<string, string> = {
  sku: "SKU",
  parentSku: "Parent SKU",
  title: "Name",
  description: "Description",
  color: "Colour",
  size: "Size",
  weight: "Weight",
  material: "Material",
  price: "Price",
  currency: "Currency",
  notes: "Notes",
  image: "Photo",
  category: "Category",
  brand: "Brand",
};

// How the file was read: its format, which column became which field, and what was set aside
function SheetPanel({ info, totalRows }: { info: ParseInfo | null; totalRows: number | null }) {
  if (!info) return <p className="text-sm text-muted-foreground">The sheet hasn&apos;t been read yet.</p>;
  const format = info.format === "shopify" ? "Shopify export" : info.format === "woocommerce" ? "WooCommerce export" : "Supplier sheet";
  return (
    <div className="space-y-6 text-sm">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Format", format],
          ["File", [info.fileType.toUpperCase(), info.sheetName, info.encoding].filter(Boolean).join(" · ")],
          ["Header row", String(info.headerRow)],
          ["Product rows", totalRows === null ? "—" : formatCount(totalRows)],
        ].map(([term, value]) => (
          <div key={term}>
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="columns-heading" className="space-y-2">
        <h3 id="columns-heading" className="font-medium">
          Columns we used
        </h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Field</th>
                <th scope="col" className="px-3 py-2 font-medium">Column in the sheet</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {Object.entries(info.columns).map(([field, header]) => (
                <tr key={field}>
                  <td className="px-3 py-2">{FIELD_NAMES[field] ?? field}</td>
                  <td className="px-3 py-2 font-mono text-xs">{header}</td>
                </tr>
              ))}
              {info.optionColumns.map((o) => (
                <tr key={o.name}>
                  <td className="px-3 py-2">Option</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {o.name} / {o.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {info.unmappedColumns.length > 0 && (
          <p className="text-muted-foreground">Kept as extra text for the AI: {info.unmappedColumns.join(", ")}</p>
        )}
      </section>

      {(info.ignoredRows.length > 0 || info.blankRows > 0) && (
        <section aria-labelledby="ignored-heading" className="space-y-2">
          <h3 id="ignored-heading" className="font-medium">
            Rows set aside
          </h3>
          {info.blankRows > 0 && <p className="text-muted-foreground">{formatCount(info.blankRows)} blank rows skipped.</p>}
          {info.ignoredRows.length > 0 && (
            <ul className="space-y-0.5">
              {info.ignoredRows.slice(0, 20).map((r) => (
                <li key={r.rowNumber}>
                  Row {r.rowNumber}: <span className="text-muted-foreground">&ldquo;{r.text}&rdquo; (not a product)</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
