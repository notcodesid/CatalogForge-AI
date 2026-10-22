"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, getJson, postJson } from "../api";
import { timeAgo } from "../format";
import { buttonClasses, ErrorState, focusClasses, linkClasses, Skeleton } from "../ui";
import { errorMessage, type ProductDetail, sendJson } from "./api";
import { ConfidenceBadge, StatusBadge, TranslationChips, UpdateWaitingBadge } from "./bits";
import { EditForm } from "./edit-form";
import { ListingPanel } from "./listing-panel";
import { NewVersionPanel } from "./new-version-panel";
import { SupplierPanel } from "./supplier-panel";
import { TranslationsPanel } from "./translations-panel";

type Loaded = { key: number; product: ProductDetail };
type Failed = { key: number; error: string; notFound: boolean };
type Notice = { tone: "success" | "danger" | "warning"; title: string; lines?: string[] } | null;

// The review screen: what the supplier sent (rows, photos) next to what the AI wrote (with how sure it was and
// where every claim came from), the actions to edit, approve, send back or delete it, and its translations. A new
// version the AI wrote for an approved product is shown above, next to the listing in the shop
export function ProductReview({ id }: { id: string }) {
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getJson<ProductDetail>(`/api/products/${id}`, controller.signal)
      .then((product) => setLoaded({ key: nonce, product }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        const notFound = err instanceof ApiError && err.status === 404;
        setFailed({ key: nonce, error: notFound ? "This product doesn't exist, or it was removed." : errorMessage(err), notFound });
      });
    return () => controller.abort();
  }, [id, nonce]);
  const reload = () => setNonce((n) => n + 1);

  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // An action's answer carries the product as it is now: shown straight away, no second request
  const [override, setOverride] = useState<{ key: number; product: ProductDetail } | null>(null);
  const product = override && (!loaded || override.key >= loaded.key) ? override.product : (loaded?.product ?? null);
  const show = (next: ProductDetail) => setOverride({ key: nonce, product: next });
  // A refresh that failed after an action keeps the product on screen, with a word that it may be out of date
  const refreshFailed = failed && product && !failed.notFound && failed.key > (loaded?.key ?? -1) ? failed : null;

  if (failed && (failed.notFound || !product)) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState
          title={failed.notFound ? "Product not found" : "Couldn't load this product"}
          message={failed.error}
          onRetry={failed.notFound ? undefined : reload}
        />
      </div>
    );
  }
  if (!product) return <ReviewSkeleton />;

  return (
    <div className="space-y-6">
      <BackLink />
      {refreshFailed && (
        <ErrorState title="Couldn't refresh this product. What you see may be out of date" message={refreshFailed.error} onRetry={reload} />
      )}
      <Header
        product={product}
        editing={editing}
        onEdit={() => {
          setEditing(true);
          setNotice(null);
        }}
        onChanged={(next, message) => {
          show(next);
          setNotice(message);
        }}
        onDeleted={() => {
          reload();
          setNotice({ tone: "success", title: "Deleted. It's out of the storefront and exports, and can be restored here" });
        }}
        onError={(message) => setNotice({ tone: "danger", title: message })}
      />
      {notice && <NoticeBox notice={notice} onClose={() => setNotice(null)} />}
      {product.reviewReasons.length > 0 && <ReviewReasons reasons={product.reviewReasons} approved={product.status === "approved"} />}
      {product.newVersion && !product.deletedAt && (
        <NewVersionPanel
          product={product}
          disabled={editing}
          onChanged={(next, message) => {
            show(next);
            setNotice({ tone: "success", title: message });
          }}
          onError={(message) => setNotice({ tone: "danger", title: message })}
        />
      )}

      {/* grid-cols-1, not the default: a wide variants table scrolls in its box instead of widening the page */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SupplierPanel product={product} onPhotosChanged={reload} />
        {editing ? (
          <EditForm
            product={product}
            onCancel={() => setEditing(false)}
            onSaved={(result) => {
              setEditing(false);
              show(result.product);
              // Prices aren't text: the sheet, not the AI, would change them, and they aren't translated
              const text = result.changed.filter((field) => field !== "prices").length;
              setNotice(
                result.changed.length
                  ? {
                      tone: result.warnings.length ? "warning" : "success",
                      title: text
                        ? `Saved. ${text === 1 ? "This field is" : "These fields are"} yours now: the AI won't overwrite ${text === 1 ? "it" : "them"}, and only what changed is translated again`
                        : "Saved. A re-upload of the sheet won't change your prices",
                      lines: result.warnings,
                    }
                  : { tone: "success", title: "Nothing changed" },
              );
            }}
          />
        ) : (
          <ListingPanel product={product} />
        )}
      </div>

      {product.deletedAt ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          The translations are kept while the product is deleted, and come back when you restore it.
        </p>
      ) : (
        <TranslationsPanel productId={product.id} version={product.updatedAt} />
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/products" className={`${linkClasses} inline-flex items-center gap-1 text-sm`}>
      <span aria-hidden>←</span> Products
    </Link>
  );
}

function Header({
  product,
  editing,
  onEdit,
  onChanged,
  onDeleted,
  onError,
}: {
  product: ProductDetail;
  editing: boolean;
  onEdit: () => void;
  onChanged: (product: ProductDetail, notice: Notice) => void;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleted = Boolean(product.deletedAt);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    run(async () => {
      const result = await postJson<{ alreadyApproved: boolean; product: ProductDetail }>(`/api/products/${product.id}/approve`);
      onChanged(result.product, { tone: "success", title: result.alreadyApproved ? "Already approved" : "Approved. It's in the storefront now" });
    });
  const restore = () =>
    run(async () => {
      const result = await postJson<{ product: ProductDetail }>(`/api/products/${product.id}/restore`);
      onChanged(result.product, { tone: "success", title: "Restored, with the status it had" });
    });
  const remove = () =>
    run(async () => {
      await sendJson("DELETE", `/api/products/${product.id}`);
      setConfirmDelete(false);
      onDeleted();
    });

  const translations = Object.fromEntries(product.translations.filter((t) => t.enabled).map((t) => [t.locale, t.status]));
  // The server refuses to approve a product with an unpriced variant, so the button says so before it's clicked,
  // and Edit (where the price is added) becomes the main action
  const unpriced = product.variants.filter((v) => v.priceCents === null).map((v) => v.sku);
  const blocked = product.status !== "approved" && !deleted && unpriced.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h1 className="break-words text-2xl font-semibold tracking-tight">{product.title}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <StatusBadge status={product.status} deleted={deleted} />
            {product.newVersion && !deleted && <UpdateWaitingBadge />}
            <span className="inline-flex items-center gap-1">
              Least sure: <ConfidenceBadge value={product.lowestConfidence} />
            </span>
            <TranslationChips translations={translations} />
            <span className="font-mono text-xs">{product.handle}</span>
            {product.lastImport && (
              <span>
                From{" "}
                <Link href={`/imports/${product.lastImport.id}`} className={linkClasses}>
                  {product.lastImport.fileName}
                </Link>{" "}
                · {timeAgo(product.lastImport.createdAt)}
              </span>
            )}
            {product.status === "approved" && !deleted && (
              <Link href={`/shop/${product.handle}`} className={linkClasses}>
                View in the shop <span aria-hidden>↗</span>
              </Link>
            )}
          </div>
        </div>

        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {deleted ? (
              <button type="button" className={buttonClasses("primary")} disabled={busy} onClick={restore}>
                Restore
              </button>
            ) : (
              <>
                {product.status !== "approved" && (
                  <button
                    type="button"
                    className={buttonClasses(blocked ? "secondary" : "primary")}
                    disabled={busy || editing || blocked}
                    aria-describedby={blocked ? "approve-blocked" : undefined}
                    onClick={approve}
                  >
                    Approve
                  </button>
                )}
                <button type="button" className={buttonClasses("secondary")} disabled={busy || editing} onClick={() => setSendingBack((s) => !s)} aria-expanded={sendingBack}>
                  Send back
                </button>
                <button type="button" className={buttonClasses(blocked ? "primary" : "secondary")} disabled={busy || editing} onClick={onEdit}>
                  Edit
                </button>
                {confirmDelete ? (
                  <span className="inline-flex items-center gap-2 rounded-md border border-danger/40 bg-danger-soft px-2">
                    <span className="text-sm text-danger">Delete it?</span>
                    <button type="button" className={buttonClasses("ghost", "sm")} disabled={busy} onClick={remove}>
                      Yes, delete
                    </button>
                    <button type="button" className={buttonClasses("ghost", "sm")} onClick={() => setConfirmDelete(false)}>
                      Keep it
                    </button>
                  </span>
                ) : (
                  <button type="button" className={`${buttonClasses("ghost")} text-danger`} disabled={busy || editing} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                )}
              </>
            )}
          </div>
          {blocked && (
            <p id="approve-blocked" className="text-sm text-danger">
              Can&apos;t approve yet:{" "}
              {unpriced.length === 1 ? `SKU ${unpriced[0]} has no price. Add it with Edit` : `SKUs ${unpriced.join(", ")} have no price. Add them with Edit`}
            </p>
          )}
        </div>
      </div>
      {sendingBack && !deleted && (
        <SendBackForm
          busy={busy}
          onCancel={() => setSendingBack(false)}
          onSend={(reason) =>
            run(async () => {
              const wasApproved = product.status === "approved";
              const result = await postJson<{ product: ProductDetail }>(`/api/products/${product.id}/send-back`, { reason });
              setSendingBack(false);
              onChanged(result.product, {
                tone: "success",
                title: wasApproved ? "Sent back. It's out of the storefront until it's approved again" : "Sent back, with your note at the top of why it needs review",
              });
            })
          }
        />
      )}
    </div>
  );
}

function SendBackForm({ busy, onSend, onCancel }: { busy: boolean; onSend: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <form
      className="space-y-2 rounded-lg border border-border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onSend(reason.trim());
      }}
    >
      <label htmlFor="send-back-reason" className="text-sm font-medium">
        Why does it need another look?
      </label>
      <textarea
        id="send-back-reason"
        rows={2}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="The photo shows the wrong colour"
        className={`w-full rounded-md border border-border bg-background p-2 text-sm ${focusClasses}`}
      />
      <div className="flex gap-2">
        <button type="submit" className={buttonClasses("primary", "sm")} disabled={busy || !reason.trim()}>
          Send back
        </button>
        <button type="button" className={buttonClasses("ghost", "sm")} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Why it needs review. For an approved product: what an upload found after it was approved (it stays in the shop)
function ReviewReasons({ reasons, approved }: { reasons: string[]; approved: boolean }) {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning-soft p-4">
      <h2 className="text-sm font-semibold text-warning">{approved ? "Found by an upload since you approved it" : "Why it needs review"}</h2>
      {approved && <p className="mt-1 text-sm">It&apos;s still in the shop. Fix what needs it with Edit, or send it back to take it out.</p>}
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {reasons.map((reason, i) => (
          <li key={i} className={reason.startsWith("Sent back: ") ? "font-medium" : undefined}>
            {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NoticeBox({ notice, onClose }: { notice: NonNullable<Notice>; onClose: () => void }) {
  const styles = {
    success: "border-success/30 bg-success-soft",
    warning: "border-warning/40 bg-warning-soft",
    danger: "border-danger/30 bg-danger-soft",
  }[notice.tone];
  return (
    <div role={notice.tone === "danger" ? "alert" : "status"} className={`flex items-start justify-between gap-3 rounded-lg border p-3 text-sm ${styles}`}>
      <div className="space-y-1">
        <p className="font-medium">{notice.title}</p>
        {notice.lines && notice.lines.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5">
            {notice.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" onClick={onClose} className={`${buttonClasses("ghost", "sm")} -my-1`} aria-label="Close">
        ✕
      </button>
    </div>
  );
}

export function ReviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading the product">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-2/3" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    </div>
  );
}
