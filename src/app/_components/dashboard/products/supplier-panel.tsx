"use client";

import { useEffect, useState } from "react";
import { getJson, type ImportPhoto } from "../api";
import { formatPrice } from "../format";
import { ROW_STATUS } from "../statuses";
import { Badge, buttonClasses, focusClasses, linkClasses, Skeleton } from "../ui";
import { errorMessage, type ProductDetail, type SourceRow, sendJson } from "./api";
import { Thumb } from "./bits";
import { textFromEarlierFile } from "./view";

// The left half of the review screen: what the supplier sent. Photos first (they say the most at a glance), then
// the sheet's rows as written and as we cleaned them, then the text the listing was written from
export function SupplierPanel({ product, onPhotosChanged }: { product: ProductDetail; onPhotosChanged: () => void }) {
  return (
    <section aria-labelledby="supplier-heading" className="space-y-5 rounded-lg border border-border bg-card p-4 md:p-5">
      <h2 id="supplier-heading" className="text-base font-semibold">
        From the supplier
      </h2>
      <Photos product={product} onChanged={onPhotosChanged} />
      <Rows rows={product.sourceRows} fileName={product.lastImport?.fileName ?? null} />
      <WrittenFrom product={product} />
    </section>
  );
}

function Photos({ product, onChanged }: { product: ProductDetail; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const takeOff = async (photoId: string) => {
    setBusy(photoId);
    setError(null);
    try {
      await sendJson("PATCH", `/api/photos/${photoId}`, { productId: null });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Photos</h3>
        {product.lastImport && !product.deletedAt && (
          <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
            {picking ? "Done adding" : "Add a photo"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {product.photos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No photos. The storefront shows a placeholder.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {product.photos.map((photo) => (
            <li key={photo.id} className="space-y-1">
              <a href={photo.url} target="_blank" rel="noreferrer" className={`block rounded-md ${focusClasses}`} title="Open the full photo">
                <Thumb url={photo.thumbnailUrl} alt={photo.fileName} size="aspect-square w-full" />
              </a>
              <p className="truncate text-xs text-muted-foreground" title={photo.fileName}>
                {photo.sku ?? photo.fileName}
              </p>
              {!product.deletedAt && (
                <button type="button" className={`${linkClasses} text-xs`} disabled={busy === photo.id} onClick={() => takeOff(photo.id)}>
                  {busy === photo.id ? "Taking off…" : "Take off"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {picking && product.lastImport && <UnmatchedPicker importId={product.lastImport.id} productId={product.id} onAdded={onChanged} />}
    </div>
  );
}

// Photos of the same import that matched nothing ("IMG_4533.jpg"): the merchant knows where they belong
function UnmatchedPicker({ importId, productId, onAdded }: { importId: string; productId: string; onAdded: () => void }) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ key: number; photos: ImportPhoto[] } | { key: number; error: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getJson<{ photos: ImportPhoto[] }>(`/api/imports/${importId}/photos?status=unmatched&limit=200`, controller.signal)
      .then((data) => setState({ key: nonce, photos: data.photos }))
      .catch((err) => {
        if (!controller.signal.aborted) setState({ key: nonce, error: errorMessage(err) });
      });
    return () => controller.abort();
  }, [importId, nonce]);

  const use = async (photoId: string) => {
    setBusy(photoId);
    setError(null);
    try {
      await sendJson("PATCH", `/api/photos/${photoId}`, { productId });
      setNonce((n) => n + 1);
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed border-border p-3">
      <p className="text-sm text-muted-foreground">Photos from this import that matched no product:</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!state && <Skeleton className="h-20" />}
      {state && "error" in state && <p className="text-sm text-danger">{state.error}</p>}
      {state && "photos" in state && state.photos.length === 0 && <p className="text-sm">None left. Every photo of this import found a product.</p>}
      {state && "photos" in state && state.photos.length > 0 && (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {state.photos.map((photo) => (
            <li key={photo.id} className="space-y-1">
              <Thumb url={photo.thumbnailUrl ?? null} alt={photo.fileName} size="aspect-square w-full" />
              <p className="truncate text-xs text-muted-foreground" title={photo.fileName}>
                {photo.fileName}
              </p>
              <button type="button" className={buttonClasses("secondary", "sm")} disabled={busy !== null || !photo.processed} onClick={() => use(photo.id)}>
                {busy === photo.id ? "Adding…" : photo.processed ? "Use" : "Still processing"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Rows({ rows, fileName }: { rows: SourceRow[]; fileName: string | null }) {
  if (!rows.length) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">
        Sheet rows{fileName ? <span className="font-normal text-muted-foreground"> · {fileName}</span> : null}
      </h3>
      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.rowNumber} className="rounded-md border border-border">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-xs">
              <span className="font-medium tabular-nums">Row {row.rowNumber}</span>
              {ROW_STATUS[row.status as keyof typeof ROW_STATUS] && (
                <Badge tone={ROW_STATUS[row.status as keyof typeof ROW_STATUS].tone}>{ROW_STATUS[row.status as keyof typeof ROW_STATUS].label}</Badge>
              )}
              {row.cleaned && row.cleaned.role !== "variant" && <span className="text-muted-foreground">{row.cleaned.role === "image" ? "Extra photo row" : "Product row"}</span>}
            </div>
            {/* minmax(0, 1fr): a long photo link in a cell wraps instead of widening the panel */}
            <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2 text-sm">
              {Object.entries(row.raw)
                .filter(([, value]) => value?.trim())
                .map(([column, value]) => (
                  <div key={column} className="contents">
                    <dt className="max-w-40 truncate text-muted-foreground" title={column}>
                      {column}
                    </dt>
                    <dd className="break-words">{value}</dd>
                  </div>
                ))}
            </dl>
            {row.cleaned && <Cleaned row={row} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

// What our cleaning made of the row, and the notes it left (a colour fixed, a unit converted, a price missing)
function Cleaned({ row }: { row: SourceRow }) {
  const c = row.cleaned!;
  const facts = [
    c.sku && `SKU ${c.sku}`,
    formatPrice(c.priceCents, c.currency) ?? "no price",
    c.size,
    c.color,
    c.weightGrams !== null && c.weightGrams !== undefined ? `${c.weightGrams} g` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-1 border-t border-border px-3 py-2 text-xs">
      <p>
        <span className="text-muted-foreground">Cleaned: </span>
        {facts.join(" · ")}
      </p>
      {c.issues.length > 0 && (
        <ul className="space-y-0.5">
          {c.issues.map((issue, i) => (
            <li key={i} className={issue.severity === "review" ? "text-warning" : "text-muted-foreground"}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The supplier's text exactly as the AI saw it. Open when the sheet on file no longer has all of it: after a
// prices-only re-upload the listing still comes from the earlier, richer file
function WrittenFrom({ product }: { product: ProductDetail }) {
  const source = product.writtenFrom;
  if (!source?.sourceRows.length) return null;
  const earlier = textFromEarlierFile(source.sourceRows, product.sourceRows);
  return (
    <details className="group rounded-md border border-border" open={earlier}>
      <summary className={`cursor-pointer list-none px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden ${focusClasses} rounded-md`}>
        <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        Text the listing was written from
        {source.language !== "en" && source.language !== "unknown" && <span className="font-normal text-muted-foreground"> · in {source.language.toUpperCase()}</span>}
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-2 text-sm">
        {earlier && <p className="text-xs text-muted-foreground">Some of this text isn&apos;t in the sheet on file now: the listing was written from an earlier upload.</p>}
        {source.sourceRows.map((r) => (
          <div key={r.row}>
            <p className="text-xs font-medium text-muted-foreground">Row {r.row}</p>
            <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
              {Object.entries(r.cells).map(([column, text]) => (
                <div key={column} className="contents">
                  <dt className="max-w-40 truncate text-muted-foreground" title={column}>
                    {column}
                  </dt>
                  <dd className="break-words">{text}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </details>
  );
}
