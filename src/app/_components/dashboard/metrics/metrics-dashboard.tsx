"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, getJson } from "../api";
import { buttonClasses, EmptyState, ErrorState, focusClasses, linkClasses, Skeleton } from "../ui";
import { type PeriodDays, periodFromParam, periodPhrase, PERIODS } from "./helpers";
import { AiSection, CatalogSection, ImportsSection, KeyNumbers, ReviewReasonsSection, TranslationsSection } from "./sections";
import type { Metrics } from "./types";

// Fresh numbers every 30 seconds while the tab is open; none while it's in the background
const REFRESH_MS = 30_000;

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; metrics: Metrics; days: PeriodDays; loadedAt: Date; refreshFailed: boolean };

// The Metrics tab. The period lives in the address (?days=1|7|30), so a link or a reload shows the same numbers
export function MetricsDashboard() {
  const days = periodFromParam(useSearchParams().get("days"));
  const [state, setState] = useState<State>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      clearTimeout(timer);
      setRefreshing(true);
      try {
        const metrics = await getJson<Metrics>(`/api/metrics?days=${days}`, controller.signal);
        setState({ status: "ready", metrics, days, loadedAt: new Date(), refreshFailed: false });
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = err instanceof ApiError ? err.message : "Can't reach the server. Check your connection";
        // A missed refresh keeps the numbers on screen and says so, instead of blanking the page
        setState((prev) => (prev.status === "ready" ? { ...prev, refreshFailed: true } : { status: "error", message }));
      } finally {
        if (!controller.signal.aborted) setRefreshing(false);
      }
      if (!controller.signal.aborted && !document.hidden) timer = setTimeout(load, REFRESH_MS);
    };

    const onVisible = () => {
      if (!document.hidden) void load();
    };
    void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [days, nonce]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav aria-label="Period" className="inline-flex rounded-md border border-border bg-card p-0.5">
          {PERIODS.map((p) => {
            const selected = p.days === days;
            return (
              <Link
                key={p.days}
                href={`/metrics?days=${p.days}`}
                replace
                scroll={false}
                aria-current={selected ? "page" : undefined}
                className={`inline-flex min-h-9 items-center rounded px-3 text-sm font-medium transition-colors ${focusClasses} ${
                  selected ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p.label}
              </Link>
            );
          })}
        </nav>
        {state.status === "ready" && (
          <p className="text-xs text-muted-foreground" role="status">
            {state.refreshFailed
              ? "Couldn't refresh: showing the last numbers"
              : `Updated ${state.loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, refreshes every 30 seconds`}
          </p>
        )}
        <button type="button" onClick={() => setNonce((n) => n + 1)} disabled={refreshing} className={`${buttonClasses("ghost", "sm")} sm:ml-auto`}>
          {refreshing ? "Refreshing…" : "Refresh now"}
        </button>
      </div>

      {state.status === "loading" && <MetricsSkeleton />}
      {state.status === "error" && <ErrorState title="Couldn't load the metrics" message={state.message} onRetry={() => setNonce((n) => n + 1)} />}
      {state.status === "ready" && (
        // A new period keeps the old numbers on screen, dimmed, until the new ones arrive: no jump, no flash
        <div aria-busy={state.days !== days} className={`space-y-10 transition-opacity motion-reduce:transition-none ${state.days !== days ? "opacity-50" : ""}`}>
          {state.metrics.imports.total === 0 && state.metrics.ai.calls === 0 && (
            <EmptyState title={`Nothing happened in ${periodPhrase(state.days)}`}>
              Imports and AI calls show up here as they happen.{" "}
              <Link href="/" className={linkClasses}>
                Upload a sheet
              </Link>{" "}
              or pick a longer period.
            </EmptyState>
          )}
          <KeyNumbers metrics={state.metrics} days={state.days} />
          <AiSection metrics={state.metrics} days={state.days} />
          <ImportsSection metrics={state.metrics} days={state.days} />
          <CatalogSection metrics={state.metrics} />
          <ReviewReasonsSection metrics={state.metrics} />
          <TranslationsSection metrics={state.metrics} />
        </div>
      )}
    </div>
  );
}

// The page's shape while the first numbers load
export function MetricsSkeleton() {
  return (
    <div className="space-y-10" aria-busy="true" aria-label="Loading the metrics">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-72" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
    </div>
  );
}
