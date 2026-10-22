"use client";

import { useEffect, useState } from "react";
import { ApiError, getJson, type ImportListItem } from "./api";
import { formatCount } from "./format";
import { ImportCard, ImportCardSkeleton } from "./import-card";
import { ACTIVE_STATUSES } from "./statuses";
import { buttonClasses, EmptyState, ErrorState } from "./ui";

type List = { total: number; imports: ImportListItem[] };
type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; list: List; refreshFailed: boolean };

const PAGE = 20;
// While something runs the list follows it closely; when everything is finished it only checks now and then
const ACTIVE_MS = 1_500;
const IDLE_MS = 10_000;
const HIDDEN_MS = 30_000;

// The upload queue with each import's live status. Asks the server again every second and a half while an
// import runs, less often when nothing does or the tab is in the background
export function ImportList({ refreshKey }: { refreshKey: number }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [limit, setLimit] = useState(PAGE);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      let active = false;
      try {
        const list = await getJson<List>(`/api/imports?limit=${limit}`, controller.signal);
        setState({ status: "ready", list, refreshFailed: false });
        active = list.imports.some((imp) => ACTIVE_STATUSES.includes(imp.status));
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = err instanceof ApiError ? err.message : "Can't reach the server. Check your connection";
        // Keep showing what we had: a missed refresh shouldn't blank the page
        setState((prev) => (prev.status === "ready" ? { ...prev, refreshFailed: true } : { status: "error", message }));
        active = true;
      } finally {
        inFlight = false;
      }
      if (controller.signal.aborted) return;
      timer = setTimeout(load, document.hidden ? HIDDEN_MS : active ? ACTIVE_MS : IDLE_MS);
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
  }, [limit, refreshKey, nonce]);

  const reload = () => setNonce((n) => n + 1);

  if (state.status === "loading") {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading imports">
        <ImportCardSkeleton />
        <ImportCardSkeleton />
      </div>
    );
  }
  if (state.status === "error") return <ErrorState title="Couldn't load your imports" message={state.message} onRetry={reload} />;

  const { list, refreshFailed } = state;
  if (!list.imports.length) {
    return <EmptyState title="No imports yet">Drop a supplier sheet above to start your first import. You&apos;ll follow its progress here, row by row.</EmptyState>;
  }
  return (
    <div className="space-y-3">
      {refreshFailed && (
        <p role="status" className="text-sm text-warning">
          Couldn&apos;t refresh just now. Trying again…
        </p>
      )}
      {list.imports.map((imp) => (
        <ImportCard key={imp.id} imp={imp} onChanged={reload} />
      ))}
      {list.total > list.imports.length && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-sm text-muted-foreground">
            Showing {formatCount(list.imports.length)} of {formatCount(list.total)} imports
          </p>
          <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setLimit((l) => l + PAGE)}>
            Show more
          </button>
        </div>
      )}
    </div>
  );
}
