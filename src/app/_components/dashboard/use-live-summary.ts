import { useEffect, useState } from "react";
import { ApiError, getJson, type ImportSummary } from "./api";

export type LiveSummary = { status: "loading" } | { status: "error"; message: string; notFound: boolean } | { status: "ready"; summary: ImportSummary };

const finished = (s: ImportSummary) => s.status === "done" || s.status === "failed" || s.status === "waiting_for_files";

// An import's summary, kept live: Server-Sent Events while it runs, ordinary requests if the stream keeps
// failing (some proxies don't let it through). Used by the import's page and by the Upload tab right after an upload
export function useLiveSummary(id: string) {
  const [state, setState] = useState<LiveSummary>({ status: "loading" });
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
