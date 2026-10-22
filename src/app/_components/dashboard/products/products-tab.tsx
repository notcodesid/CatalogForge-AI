"use client";

import type { RowSelectionState } from "@tanstack/react-table";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CATEGORIES } from "@/server/ai/taxonomy";
import { ApiError, getJson, type ImportListItem, postJson } from "../api";
import { formatCount } from "../format";
import { buttonClasses, EmptyState, ErrorState, focusClasses, linkClasses, Skeleton } from "../ui";
import type { BulkApproveResult, ProductList, ProductStatus } from "./api";
import { ExportMenu } from "./export-menu";
import { ProductTable } from "./product-table";
import {
  categoryGroups,
  hasFilters,
  type ListView,
  PAGE_SIZES,
  type PageSize,
  PRODUCT_STATUS_LABEL,
  PRODUCT_STATUSES,
  readView,
  REVIEW_THRESHOLD,
  type Sort,
  viewToApiQuery,
  viewToSearch,
  withChange,
} from "./view";

type Loaded = { key: string; data: ProductList } | { key: string; error: string };

// The Products tab: every product, a page at a time, to search, filter, sort, select, approve and export. What's
// shown is read from the address (filters, sort, page), so a view can be shared and survives a reload
export function ProductsTab() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view = useMemo(() => readView(new URLSearchParams(params.toString())), [params]);

  // Filters and pages are new history entries (Back goes to the previous view); typing in search replaces
  const go = useCallback(
    (next: ListView, mode: "push" | "replace" = "push") => {
      const url = `${pathname}${viewToSearch(next)}`;
      if (mode === "push") router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [pathname, router],
  );

  const query = viewToApiQuery(view);
  const [nonce, setNonce] = useState(0);
  const key = `${query}#${nonce}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getJson<ProductList>(`/api/products?${query}`, controller.signal)
      .then((data) => setLoaded({ key, data }))
      .catch((err) => {
        if (!controller.signal.aborted) setLoaded({ key, error: err instanceof ApiError ? err.message : "Can't reach the server" });
      });
    return () => controller.abort();
  }, [query, key]);
  const reload = () => setNonce((n) => n + 1);

  // While a new page loads, the last one stays on screen (dimmed) instead of jumping to a skeleton
  const fresh = loaded?.key === key;
  const data = loaded && "data" in loaded ? loaded.data : null;
  const error = fresh && loaded && "error" in loaded ? loaded.error : null;

  const [selection, setSelection] = useState<RowSelectionState>({});
  const selectedIds = Object.keys(selection).filter((id) => selection[id]);
  const [bulk, setBulk] = useState<{ status: "idle" } | { status: "working" } | { status: "done"; result: BulkApproveResult } | { status: "error"; message: string }>({
    status: "idle",
  });

  const approve = async (body: { ids: string[] } | { importId: string }) => {
    setBulk({ status: "working" });
    try {
      const result = await postJson<BulkApproveResult>("/api/products/bulk-approve", body);
      setBulk({ status: "done", result });
      setSelection({});
      reload();
    } catch (err) {
      setBulk({ status: "error", message: err instanceof ApiError ? err.message : "Can't reach the server" });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {data ? `${formatCount(data.total)} ${view.deleted ? "deleted " : ""}product${data.total === 1 ? "" : "s"}${hasFilters(view) ? " match" : ""}` : " "}
          </p>
        </div>
        <ExportMenu />
      </div>

      <Filters view={view} onChange={(next, mode) => go(next, mode)} />

      {(selectedIds.length > 0 || view.importId) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          {selectedIds.length > 0 && (
            <>
              <span className="text-sm font-medium tabular-nums">{formatCount(selectedIds.length)} selected</span>
              <button type="button" className={buttonClasses("primary", "sm")} disabled={bulk.status === "working"} onClick={() => approve({ ids: selectedIds })}>
                Approve selected
              </button>
              <button type="button" className={buttonClasses("ghost", "sm")} onClick={() => setSelection({})}>
                Clear selection
              </button>
            </>
          )}
          {view.importId && !view.deleted && (
            <button
              type="button"
              className={`${buttonClasses("secondary", "sm")} sm:ml-auto`}
              disabled={bulk.status === "working"}
              onClick={() => approve({ importId: view.importId })}
            >
              Approve every ready product of this import
            </button>
          )}
        </div>
      )}
      <BulkResult state={bulk} onClose={() => setBulk({ status: "idle" })} />

      {error && <ErrorState title="Couldn't load the products" message={error} onRetry={reload} />}
      {!data && !error && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading products">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      )}
      {data && data.products.length === 0 && data.total > 0 && !error && (
        // A page past the end (products were approved or deleted meanwhile)
        <EmptyState title="This page is empty">
          <button type="button" className={linkClasses} onClick={() => go(withChange(view, { page: Math.max(1, data.pages) }))}>
            Go to the last page
          </button>
        </EmptyState>
      )}
      {data && data.total === 0 && !error && (
        <EmptyState title={hasFilters(view) ? "No products match" : "No products yet"}>
          {hasFilters(view) ? (
            <button type="button" className={linkClasses} onClick={() => go({ ...readView(new URLSearchParams()), pageSize: view.pageSize })}>
              Clear the filters
            </button>
          ) : (
            <>
              Products show up here once a sheet has been imported.{" "}
              <Link href="/" className={linkClasses}>
                Upload a sheet
              </Link>
            </>
          )}
        </EmptyState>
      )}
      {data && data.products.length > 0 && (
        <div className={`space-y-3 transition-opacity ${fresh ? "" : "opacity-60"}`} aria-busy={!fresh}>
          <ProductTable products={data.products} view={view} selection={selection} onSelectionChange={setSelection} onViewChange={(next) => go(next)} />
          <Pagination view={view} total={data.total} pages={data.pages} onChange={(next) => go(next)} />
        </div>
      )}
    </div>
  );
}

function BulkResult({ state, onClose }: { state: { status: string; result?: BulkApproveResult; message?: string }; onClose: () => void }) {
  if (state.status === "error") return <ErrorState title="Couldn't approve" message={state.message ?? ""} />;
  if (state.status !== "done" || !state.result) return null;
  const { approved, alreadyApproved, skipped } = state.result;
  return (
    <div role="status" className={`space-y-2 rounded-lg border p-3 text-sm ${skipped.length ? "border-warning/40 bg-warning-soft" : "border-success/30 bg-success-soft"}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">
          Approved {formatCount(approved)} product{approved === 1 ? "" : "s"}
          {alreadyApproved > 0 && `, ${formatCount(alreadyApproved)} already approved`}
          {skipped.length > 0 && `. ${formatCount(skipped.length)} couldn't be approved:`}
        </p>
        <button type="button" onClick={onClose} className={`${buttonClasses("ghost", "sm")} -my-1`} aria-label="Close">
          ✕
        </button>
      </div>
      {skipped.length > 0 && (
        <ul className="space-y-1">
          {skipped.slice(0, 20).map((s) => (
            <li key={s.id}>
              <Link href={`/products/${s.id}`} className={linkClasses}>
                {s.title ?? "A product"}
              </Link>
              : {s.reason}
            </li>
          ))}
          {skipped.length > 20 && <li className="text-muted-foreground">and {formatCount(skipped.length - 20)} more</li>}
        </ul>
      )}
    </div>
  );
}

const selectClasses = `min-h-10 rounded-md border border-border bg-card px-3 text-sm sm:min-h-9 ${focusClasses}`;

// On a phone the sortable columns are folded away, so sorting is picked here
const SORT_CHOICES: { value: `${Sort}:${"asc" | "desc"}`; label: string }[] = [
  { value: "updatedAt:desc", label: "Recently changed" },
  { value: "status:asc", label: "Needs review first" },
  { value: "confidence:asc", label: "Least sure first" },
  { value: "title:asc", label: "Name, A to Z" },
  { value: "price:asc", label: "Cheapest first" },
  { value: "price:desc", label: "Most expensive first" },
];
const SORT_NAMES: Record<Sort, string> = { title: "name", status: "status", category: "category", updatedAt: "last change", confidence: "confidence", price: "price" };

function Filters({ view, onChange }: { view: ListView; onChange: (next: ListView, mode?: "push" | "replace") => void }) {
  const groups = useMemo(() => categoryGroups(CATEGORIES), []);
  const imports = useRecentImports();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={view.search} onSearch={(search) => onChange(withChange(view, { search }), "replace")} />
        <select
          aria-label="Category"
          className={`${selectClasses} w-full sm:w-auto sm:max-w-full`}
          value={view.category}
          onChange={(e) => onChange(withChange(view, { category: e.target.value }))}
        >
          <option value="">All categories</option>
          {groups.map((g) =>
            g.children.length ? (
              <optgroup key={g.top} label={g.top}>
                <option value={g.top}>All of {g.top}</option>
                {g.children.map((c) => (
                  <option key={c} value={c}>
                    {c.split(" > ").slice(1).join(" › ")}
                  </option>
                ))}
              </optgroup>
            ) : (
              <option key={g.top} value={g.top}>
                {g.top}
              </option>
            ),
          )}
        </select>
        <select
          aria-label="Import"
          className={`${selectClasses} w-full sm:w-auto sm:max-w-64`}
          value={view.importId}
          onChange={(e) => onChange(withChange(view, { importId: e.target.value }))}
        >
          <option value="">From any import</option>
          {/* An import picked by link from the Upload tab may be older than the recent ones listed */}
          {view.importId && !imports.some((i) => i.id === view.importId) && <option value={view.importId}>The import from the link</option>}
          {imports.map((i) => (
            <option key={i.id} value={i.id}>
              {i.fileName} · {new Date(i.createdAt).toLocaleDateString("en", { day: "numeric", month: "short" })}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort by"
          className={`${selectClasses} w-full sm:hidden`}
          value={`${view.sort}:${view.order}`}
          onChange={(e) => {
            const [sort, order] = e.target.value.split(":") as [Sort, "asc" | "desc"];
            onChange(withChange(view, { sort, order }));
          }}
        >
          {/* A link from a wider screen may be sorted by a column that isn't a choice here */}
          {!SORT_CHOICES.some((c) => c.value === `${view.sort}:${view.order}`) && (
            <option value={`${view.sort}:${view.order}`}>
              By {SORT_NAMES[view.sort]}, {view.order === "asc" ? "ascending" : "descending"}
            </option>
          )}
          {SORT_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        {PRODUCT_STATUSES.map((status: ProductStatus) => {
          const on = view.status.includes(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={on}
              className={buttonClasses(on ? "primary" : "secondary", "sm")}
              onClick={() => onChange(withChange(view, { status: on ? view.status.filter((s) => s !== status) : [...view.status, status] }))}
            >
              {PRODUCT_STATUS_LABEL[status].label}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={view.lowConfidence}
          title={`A field the AI scored under ${REVIEW_THRESHOLD}%`}
          className={buttonClasses(view.lowConfidence ? "primary" : "secondary", "sm")}
          onClick={() => onChange(withChange(view, { lowConfidence: !view.lowConfidence }))}
        >
          Low confidence
        </button>
        <button
          type="button"
          aria-pressed={view.deleted}
          className={buttonClasses(view.deleted ? "primary" : "secondary", "sm")}
          onClick={() => onChange(withChange(view, { deleted: !view.deleted }))}
        >
          Deleted
        </button>
        {hasFilters(view) && (
          <button
            type="button"
            className={`${buttonClasses("ghost", "sm")} text-muted-foreground`}
            onClick={() => onChange({ ...readView(new URLSearchParams()), pageSize: view.pageSize, sort: view.sort, order: view.order })}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

// The search box writes to the address a moment after typing stops, so every key press isn't a new request
function SearchBox({ value, onSearch }: { value: string; onSearch: (search: string) => void }) {
  const [text, setText] = useState(value);
  // The search on its way to the address
  const [sent, setSent] = useState<string | null>(null);
  // The address changed from elsewhere (Back, "Clear filters"): show what it says. Our own search arriving there
  // doesn't replace the box, which may already hold the next few letters typed
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setSent(null);
    if (value !== sent) setText(value);
  }
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => {
      setSent(text.trim());
      onSearch(text.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [text, value, onSearch]);

  return (
    // A line of its own on a phone, next to the filters from tablet width
    <div className="relative w-full min-w-0 sm:w-auto sm:max-w-sm sm:flex-1">
      <label htmlFor="product-search" className="sr-only">
        Search products
      </label>
      <input
        id="product-search"
        type="search"
        placeholder="Search by name, handle or SKU"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className={`min-h-10 w-full rounded-md border border-border bg-card px-3 text-sm placeholder:text-muted-foreground sm:min-h-9 ${focusClasses}`}
      />
    </div>
  );
}

// The latest imports, for the import filter
function useRecentImports() {
  const [imports, setImports] = useState<ImportListItem[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    getJson<{ imports: ImportListItem[] }>("/api/imports?limit=50", controller.signal)
      .then((data) => setImports(data.imports))
      .catch(() => {
        // Without the list the filter still works from a link; nothing to show
      });
    return () => controller.abort();
  }, []);
  return imports;
}

function Pagination({ view, total, pages, onChange }: { view: ListView; total: number; pages: number; onChange: (next: ListView) => void }) {
  const first = (view.page - 1) * view.pageSize + 1;
  const last = Math.min(view.page * view.pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <label htmlFor="page-size">Rows per page</label>
        <select
          id="page-size"
          className={selectClasses}
          value={view.pageSize}
          onChange={(e) => onChange(withChange(view, { pageSize: Number(e.target.value) as PageSize }))}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <p className="text-sm text-muted-foreground tabular-nums">
        {total > 0 ? `${formatCount(first)}–${formatCount(last)} of ${formatCount(total)}` : "Nothing to show"}
        {pages > 1 && ` · page ${formatCount(view.page)} of ${formatCount(pages)}`}
      </p>
      <div className="flex gap-2">
        <button type="button" className={buttonClasses("secondary", "sm")} disabled={view.page <= 1} onClick={() => onChange(withChange(view, { page: view.page - 1 }))}>
          Previous
        </button>
        <button
          type="button"
          className={buttonClasses("secondary", "sm")}
          disabled={view.page >= pages}
          onClick={() => onChange(withChange(view, { page: view.page + 1 }))}
        >
          Next
        </button>
      </div>
    </div>
  );
}
