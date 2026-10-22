"use client";

import { useEffect, useState } from "react";
import { ApiError, getJson, type ImportRow, type RowCounts, type RowStatus } from "./api";
import { formatCount, formatPrice } from "./format";
import { ROW_STATUS } from "./statuses";
import { Badge, buttonClasses, EmptyState, ErrorState, Skeleton } from "./ui";

const PAGE = 50;
const FILTERS: (RowStatus | "all")[] = ["all", "needs_review", "failed", "done", "pending"];

// Every row of the sheet: what it became and, for rows that need review or failed, why. Filtered by status,
// 50 at a time. Reloads when the import's counts change, so it follows a running import
export function RowsPanel({ importId, counts }: { importId: string; counts: RowCounts }) {
  const [filter, setFilter] = useState<RowStatus | "all">("all");
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; total: number; rows: ImportRow[] }>({
    status: "loading",
  });
  const [nonce, setNonce] = useState(0);
  const version = JSON.stringify(counts);

  useEffect(() => {
    const controller = new AbortController();
    const status = filter === "all" ? "" : `&status=${filter}`;
    getJson<{ total: number; rows: ImportRow[] }>(`/api/imports/${importId}/rows?limit=${PAGE}&offset=${offset}${status}`, controller.signal)
      .then((page) => setState({ status: "ready", ...page }))
      .catch((err) => {
        if (!controller.signal.aborted) setState({ status: "error", message: err instanceof ApiError ? err.message : "Can't reach the server" });
      });
    return () => controller.abort();
  }, [importId, filter, offset, version, nonce]);

  const count = (f: RowStatus | "all") => (f === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : f === "pending" ? counts.pending + counts.processing : counts[f]);

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Show rows" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => {
              setFilter(f);
              setOffset(0);
            }}
            className={`${buttonClasses(filter === f ? "primary" : "secondary", "sm")} tabular-nums`}
          >
            {f === "all" ? "All" : ROW_STATUS[f].label} ({formatCount(count(f))})
          </button>
        ))}
      </div>

      {state.status === "loading" && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading rows">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      )}
      {state.status === "error" && <ErrorState title="Couldn't load the rows" message={state.message} onRetry={() => setNonce((n) => n + 1)} />}
      {state.status === "ready" && state.rows.length === 0 && (
        <EmptyState title={filter === "all" ? "No rows yet" : `No rows that are ${ROW_STATUS[filter].label.toLowerCase()}`}>
          {filter === "all" ? "The rows show up here once the sheet has been read." : "Pick another filter to see the other rows."}
        </EmptyState>
      )}
      {state.status === "ready" && state.rows.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Row</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2 font-medium">SKU</th>
                  <th scope="col" className="px-3 py-2 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2 font-medium">Price</th>
                  <th scope="col" className="px-3 py-2 font-medium">What happened</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {state.rows.map((row) => (
                  <RowLine key={row.rowNumber} row={row} />
                ))}
              </tbody>
            </table>
          </div>
          <Pager offset={offset} total={state.total} page={PAGE} noun="rows" onChange={setOffset} />
        </>
      )}
    </div>
  );
}

function RowLine({ row }: { row: ImportRow }) {
  const c = row.cleaned;
  const status = ROW_STATUS[row.status];
  // Why it needs review or failed; otherwise the notes our cleaning left (a colour fixed, a currency assumed)
  const notes = row.reason ? row.reason.split("; ") : (c?.issues ?? []).filter((i) => i.severity === "info").map((i) => i.message);
  const role = c && c.role !== "variant" ? (c.role === "image" ? "Extra photo row" : "Product row") : null;
  return (
    <tr className="align-top">
      <td className="px-3 py-2 tabular-nums text-muted-foreground">{row.rowNumber}</td>
      <td className="px-3 py-2">
        <Badge tone={status.tone}>{status.label}</Badge>
      </td>
      <td className="px-3 py-2 font-mono text-xs">{c?.sku ?? "—"}</td>
      <td className="px-3 py-2">
        <span className="block max-w-56 break-words">{c?.title ?? <span className="text-muted-foreground">No name</span>}</span>
        {(c?.size || c?.color || role) && <span className="text-xs text-muted-foreground">{[role, c?.size, c?.color].filter(Boolean).join(" · ")}</span>}
      </td>
      <td className="px-3 py-2 tabular-nums">{formatPrice(c?.priceCents ?? null, c?.currency ?? null) ?? <span className="text-muted-foreground">—</span>}</td>
      <td className="px-3 py-2">
        {notes.length ? (
          <ul className={`max-w-md space-y-0.5 ${row.reason ? "" : "text-muted-foreground"}`}>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

export function Pager({ offset, total, page, noun, onChange }: { offset: number; total: number; page: number; noun: string; onChange: (offset: number) => void }) {
  if (total <= page) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground tabular-nums">
        {formatCount(offset + 1)}–{formatCount(Math.min(offset + page, total))} of {formatCount(total)} {noun}
      </p>
      <div className="flex gap-2">
        <button type="button" className={buttonClasses("secondary", "sm")} disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - page))}>
          Previous
        </button>
        <button type="button" className={buttonClasses("secondary", "sm")} disabled={offset + page >= total} onClick={() => onChange(offset + page)}>
          Next
        </button>
      </div>
    </div>
  );
}
