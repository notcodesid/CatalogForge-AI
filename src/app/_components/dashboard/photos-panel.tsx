"use client";

import { useEffect, useState } from "react";
import { ApiError, getJson, type ImportPhoto, type ImportSummary, type PhotoStatus } from "./api";
import { formatCount } from "./format";
import { Pager } from "./rows-panel";
import { PHOTO_STATUS } from "./statuses";
import { Badge, buttonClasses, EmptyState, ErrorState, Skeleton } from "./ui";

const PAGE = 48;
const FILTERS: (PhotoStatus | "all")[] = ["all", "matched", "unmatched", "rejected"];

// The photo report: every photo of the import, which product it went to and how, or why it's unmatched or
// rejected. Plus the files the sheet names that nobody uploaded
export function PhotosPanel({ importId, summary }: { importId: string; summary: ImportSummary }) {
  const [filter, setFilter] = useState<PhotoStatus | "all">("all");
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; total: number; photos: ImportPhoto[] }>({
    status: "loading",
  });
  const [nonce, setNonce] = useState(0);
  const { photos } = summary;
  const version = JSON.stringify([photos.matched, photos.unmatched, photos.rejected, photos.waitingToBeProcessed]);

  useEffect(() => {
    const controller = new AbortController();
    const status = filter === "all" ? "" : `&status=${filter}`;
    getJson<{ total: number; photos: ImportPhoto[] }>(`/api/imports/${importId}/photos?limit=${PAGE}&offset=${offset}${status}`, controller.signal)
      .then((page) => setState({ status: "ready", ...page }))
      .catch((err) => {
        if (!controller.signal.aborted) setState({ status: "error", message: err instanceof ApiError ? err.message : "Can't reach the server" });
      });
    return () => controller.abort();
  }, [importId, filter, offset, version, nonce]);

  const count = (f: PhotoStatus | "all") => (f === "all" ? photos.total : photos[f]);

  return (
    <div className="space-y-6">
      {photos.missing.length > 0 && (
        <section aria-labelledby="missing-photos" className="rounded-lg border border-warning/40 bg-warning-soft p-4 text-sm">
          <h3 id="missing-photos" className="font-medium text-warning">
            The sheet names {formatCount(photos.missing.length)} photo{photos.missing.length === 1 ? "" : "s"} that weren&apos;t uploaded
          </h3>
          <ul className="mt-2 space-y-0.5">
            {photos.missing.slice(0, 20).map((m) => (
              <li key={m.file} className="break-all">
                {m.file} <span className="text-muted-foreground">(row{m.rows.length === 1 ? "" : "s"} {m.rows.join(", ")})</span>
              </li>
            ))}
            {photos.missing.length > 20 && <li>and {formatCount(photos.missing.length - 20)} more</li>}
          </ul>
        </section>
      )}
      {photos.linksOverLimit > 0 && (
        <p className="text-sm text-warning">
          {formatCount(photos.linksOverLimit)} photo links in the sheet weren&apos;t downloaded: the import already had the most photos allowed.
        </p>
      )}

      {photos.total === 0 ? (
        <EmptyState title="No photos in this import">Photos come with the sheet when you upload them, or from photo links in the sheet&apos;s image column.</EmptyState>
      ) : (
        <>
          <div role="group" aria-label="Show photos" className="flex flex-wrap gap-2">
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
                {f === "all" ? "All" : PHOTO_STATUS[f].label} ({formatCount(count(f))})
              </button>
            ))}
          </div>
          {photos.waitingToBeProcessed > 0 && <p className="text-sm text-muted-foreground">{formatCount(photos.waitingToBeProcessed)} still being processed.</p>}

          {state.status === "loading" && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading photos">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="aspect-square" />
              ))}
            </div>
          )}
          {state.status === "error" && <ErrorState title="Couldn't load the photos" message={state.message} onRetry={() => setNonce((n) => n + 1)} />}
          {state.status === "ready" && state.photos.length === 0 && (
            <EmptyState title={`No ${filter === "all" ? "" : `${PHOTO_STATUS[filter as PhotoStatus].label.toLowerCase()} `}photos`}>Pick another filter to see the others.</EmptyState>
          )}
          {state.status === "ready" && state.photos.length > 0 && (
            <>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {state.photos.map((photo) => (
                  <PhotoTile key={photo.id} photo={photo} />
                ))}
              </ul>
              <Pager offset={offset} total={state.total} page={PAGE} noun="photos" onChange={setOffset} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function PhotoTile({ photo }: { photo: ImportPhoto }) {
  const status = PHOTO_STATUS[photo.status];
  const name = photo.sourceUrl ? (photo.sourceUrl.split("?")[0].split("/").pop() ?? photo.fileName) : photo.fileName;
  return (
    <li className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex aspect-square items-center justify-center bg-muted">
        {photo.thumbnailUrl ? (
          // The API already serves a resized WebP thumbnail; next/image would need a config change for its query string
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo.thumbnailUrl} alt={name} width={photo.width ?? 400} height={photo.height ?? 400} loading="lazy" className="h-full w-full object-contain" />
        ) : (
          <span className="px-3 text-center text-xs text-muted-foreground">{photo.status === "rejected" ? "Not usable" : "Being processed"}</span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3 text-sm">
        <p className="break-all font-medium" title={photo.fileName}>
          {name}
        </p>
        <div>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        {photo.productTitle && (
          <p>
            On <span className="font-medium">{photo.productTitle}</span>
            {photo.sku && <span className="text-muted-foreground"> ({photo.sku})</span>}
          </p>
        )}
        {photo.reason && <p className="text-muted-foreground">{photo.reason}</p>}
        {photo.sourceUrl && <p className="break-all text-xs text-muted-foreground">From a link in the sheet</p>}
      </div>
    </li>
  );
}
