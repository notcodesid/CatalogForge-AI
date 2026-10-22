"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, postJson, type ImportListItem, type RetryResult } from "./api";
import { asSentence, capitalize, formatCount, formatDuration, resumingIn, timeAgo } from "./format";
import { productsLine } from "./import-progress";
import { IMPORT_STATUS, LANGUAGE_NAMES, ROW_STATUS } from "./statuses";
import { Badge, buttonClasses, Dot, linkClasses, ProgressBar } from "./ui";

// The card fields both the list and the detail page have. On the detail page "missing" is the list of files,
// in the list it's their number. Only the detail page knows which earlier files the updated products came from
export type CardImport = Omit<ImportListItem, "photos"> & {
  photos: Omit<ImportListItem["photos"], "missing"> & { missing: number | unknown[] };
  earlierFiles?: string[];
};

function phaseLine(imp: CardImport) {
  if (imp.status === "done") return imp.startedAt && imp.finishedAt ? `Finished in ${formatDuration(Date.parse(imp.finishedAt) - Date.parse(imp.startedAt))}` : "Finished";
  if (imp.status === "failed") return "Stopped: the file couldn't be imported";
  const { rows } = imp;
  const total = imp.totalRows ?? Object.values(rows).reduce((a, b) => a + b, 0);
  const finished = rows.done + rows.needs_review + rows.failed;
  return imp.phase === "writing products" && total ? `Writing products: ${formatCount(finished)} of ${formatCount(total)} rows` : capitalize(imp.phase);
}

function retryResultText(result: RetryResult) {
  const parts = [];
  if (result.rowsRetried) parts.push(`trying ${formatCount(result.rowsRetried)} row${result.rowsRetried === 1 ? "" : "s"} again`);
  if (result.translationsRetried) parts.push(`translating ${formatCount(result.translationsRetried)} product${result.translationsRetried === 1 ? "" : "s"} again`);
  const text = parts.length ? capitalize(parts.join(" and ")) : "Nothing the AI can try again";
  return result.rowsNotRetryable
    ? `${text}. ${formatCount(result.rowsNotRetryable)} row${result.rowsNotRetryable === 1 ? "" : "s"} failed while the sheet was read: fix ${result.rowsNotRetryable === 1 ? "it" : "them"} in the sheet and upload it again`
    : text;
}

export function ImportCard({ imp, onChanged, headingLevel = 3, showDetailsLink = true }: { imp: CardImport; onChanged?: () => void; headingLevel?: 2 | 3; showDetailsLink?: boolean }) {
  const [action, setAction] = useState<{ busy: boolean; message?: string; failed?: boolean }>({ busy: false });
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const status = IMPORT_STATUS[imp.status];
  const { rows, photos } = imp;
  const total = imp.totalRows ?? Object.values(rows).reduce((a, b) => a + b, 0);
  const missing = typeof photos.missing === "number" ? photos.missing : photos.missing.length;
  const failedTranslations = Object.values(imp.translations).reduce((sum, t) => sum + t.failed, 0);
  const canRetry = (rows.failed > 0 || failedTranslations > 0) && imp.status !== "failed" && imp.status !== "waiting_for_files";

  const run = async (path: string, done: (body: unknown) => string) => {
    setAction({ busy: true });
    try {
      setAction({ busy: false, message: done(await postJson(path)) });
    } catch (err) {
      setAction({ busy: false, failed: true, message: err instanceof ApiError ? err.message : "Something went wrong. Try again" });
    }
    onChanged?.();
  };

  const counts: { status: keyof typeof rows; value: number }[] = [
    { status: "done", value: rows.done },
    { status: "needs_review", value: rows.needs_review },
    { status: "failed", value: rows.failed },
    { status: "pending", value: rows.pending + rows.processing },
  ];

  return (
    <article aria-labelledby={`import-${imp.id}`} className="space-y-4 rounded-lg border border-border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Heading id={`import-${imp.id}`} className="break-all font-medium">
            {imp.fileName}
          </Heading>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Uploaded{" "}
            <time dateTime={imp.createdAt} title={new Date(imp.createdAt).toLocaleString("en")}>
              {timeAgo(imp.createdAt)}
            </time>{" "}
            · {phaseLine(imp)}
          </p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      {imp.status === "paused" && (
        <p className="rounded-md bg-paused-soft px-3 py-2 text-sm">
          <span className="font-medium text-paused">Paused — {resumingIn(imp.pausedUntil)}.</span> {asSentence(imp.pauseReason ?? "The AI provider asked us to slow down")}
          {/* The reason may already say it carries on by itself (out of credit) */}
          {!/carries on/i.test(imp.pauseReason ?? "") && " Nothing is lost: it carries on by itself."}
        </p>
      )}
      {imp.status === "failed" && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm">
          <span className="font-medium text-danger">{asSentence(imp.error ?? "This file couldn't be imported")}</span>
          {/* Most reasons already say what to do ("Split it into smaller files", "...and upload it again") */}
          {!/upload|split/i.test(imp.error ?? "") && " Fix the file and upload it again."}
        </p>
      )}
      {imp.status === "waiting_for_files" && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">The sheet is saved but its photos never finished uploading. Start it with the photos it has, or upload again.</p>
      )}

      {total > 0 && (
        <div className="space-y-2">
          <ProgressBar
            label={counts.map((c) => `${c.value} ${ROW_STATUS[c.status].label.toLowerCase()}`).join(", ")}
            segments={counts.map((c) => ({ value: c.value, tone: ROW_STATUS[c.status].tone }))}
          />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            {counts.map((c) => (
              <div key={c.status} className="flex items-center gap-2">
                <Dot tone={ROW_STATUS[c.status].tone} />
                <dt className="text-muted-foreground">{ROW_STATUS[c.status].label}</dt>
                <dd className="font-medium tabular-nums">{formatCount(c.value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {(imp.products > 0 || photos.total > 0 || Object.keys(imp.translations).length > 0) && (
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
          {imp.products > 0 && <li className="text-foreground tabular-nums">{productsLine(imp)}</li>}
          {photos.total > 0 && (
            <li>
              Photos: <span className="tabular-nums">{formatCount(photos.matched)}</span> matched · {formatCount(photos.unmatched)} unmatched ·{" "}
              {formatCount(photos.rejected)} rejected
              {photos.waitingToBeProcessed > 0 && ` · ${formatCount(photos.waitingToBeProcessed)} being processed`}
            </li>
          )}
          {missing > 0 && <li className="text-warning">The sheet names {formatCount(missing)} photo{missing === 1 ? "" : "s"} that weren&apos;t uploaded</li>}
          {photos.linksOverLimit > 0 && <li className="text-warning">{formatCount(photos.linksOverLimit)} photo links skipped (over the photo limit)</li>}
          {Object.entries(imp.translations).map(([locale, t]) => {
            const all = t.done + t.pending + t.failed;
            return (
              <li key={locale}>
                {LANGUAGE_NAMES[locale] ?? locale.toUpperCase()}: <span className="tabular-nums">{formatCount(t.done)}</span>/{formatCount(all)} translated
                {t.failed > 0 && <span className="text-danger"> · {formatCount(t.failed)} failed</span>}
              </li>
            );
          })}
        </ul>
      )}

      {(showDetailsLink || canRetry || imp.status === "waiting_for_files") && (
        <div className="flex flex-wrap items-center gap-3">
          {showDetailsLink && (
            <Link href={`/imports/${imp.id}`} className={linkClasses}>
              Rows and photos<span className="sr-only"> of {imp.fileName}</span>
            </Link>
          )}
          {canRetry && (
            <button
              type="button"
              className={buttonClasses("secondary", "sm")}
              disabled={action.busy}
              aria-busy={action.busy}
              onClick={() => run(`/api/imports/${imp.id}/retry`, (body) => retryResultText(body as RetryResult))}
            >
              {action.busy ? "Trying again…" : "Try failed ones again"}
            </button>
          )}
          {imp.status === "waiting_for_files" && (
            <button
              type="button"
              className={buttonClasses("secondary", "sm")}
              disabled={action.busy}
              aria-busy={action.busy}
              onClick={() => run(`/api/imports/${imp.id}/start`, () => "Started")}
            >
              Start with the photos it has
            </button>
          )}
          <p aria-live="polite" className={`text-sm ${action.failed ? "text-danger" : "text-muted-foreground"}`}>
            {action.message}
          </p>
        </div>
      )}
    </article>
  );
}

export function ImportCardSkeleton() {
  return (
    <div aria-hidden className="space-y-4 rounded-lg border border-border bg-card p-4 md:p-5">
      <div className="h-5 w-48 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-2 w-full animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
    </div>
  );
}
