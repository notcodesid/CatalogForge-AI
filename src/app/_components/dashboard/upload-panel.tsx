"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ApiError, postForm, postJson } from "./api";
import { asSentence, formatBytes, formatCount, resumingIn } from "./format";
import { nextStep, nowDoing, photosLine, productsLine, rowsLine } from "./import-progress";
import { CURRENCIES, LIMITS } from "./limits";
import { buttonClasses, focusClasses, linkClasses, Meter, Spinner } from "./ui";
import { EMPTY, isZip, photoBatches, sortFiles, type Picked } from "./upload-files";
import { useLiveSummary } from "./use-live-summary";

type PhotoResult = { added: number; alreadyUploaded: number; refused: { fileName: string; reason: string }[] };
type Progress = { step: "sheet" | "photos" | "starting"; sentBytes: number; totalBytes: number; sentFiles: number; totalFiles: number };
type Outcome =
  | { kind: "started"; importId: string; photos?: PhotoResult }
  | { kind: "already-running"; importId: string }
  | { kind: "stopped"; importId?: string }
  | { kind: "error"; message: string; importId?: string };

// Everything in a dropped folder (and its subfolders). The entries must be read before the first await: the
// browser empties the drop's file list once the event handler returns
async function filesFromDrop(transfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(transfer.items ?? [])
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (!entries.length) return Array.from(transfer.files);
  const files: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) return;
      for (const child of batch) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  return files;
}

// A dropped connection or a busy server gets two more tries; a refusal (too many photos, already started) doesn't
async function withRetries<T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      const temporary = err instanceof ApiError && (err.status === 0 || err.status >= 500);
      if (!temporary || attempt >= 3 || signal.aborted) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

export function UploadPanel({ onChanged }: { onChanged: () => void }) {
  const ids = { files: useId(), folder: useId(), currency: useId(), help: useId() };
  const folderInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [picked, setPicked] = useState<Picked>(EMPTY);
  const [currency, setCurrency] = useState("EUR");
  const [dragging, setDragging] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const busy = progress !== null;

  // Picking a folder isn't a standard attribute, so React can't set it
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const add = (files: File[]) => {
    setProblem(null);
    // The import just started stays in view while the merchant picks the files for the next one
    setOutcome((o) => (o?.kind === "started" ? o : null));
    setPicked((current) => sortFiles(files, current));
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(0);
    if (busy) return;
    add(await filesFromDrop(e.dataTransfer));
  };

  const photoCount = picked.photos.filter((p) => !isZip(p)).length;
  const zipCount = picked.photos.length - photoCount;
  const photoBytes = picked.photos.reduce((sum, p) => sum + p.size, 0);

  async function upload() {
    if (!picked.sheet) return setProblem("Add the supplier sheet (CSV or Excel) first");
    if (photoCount > LIMITS.photosPerImport) {
      return setProblem(`An import can have at most ${formatCount(LIMITS.photosPerImport)} photos. You picked ${formatCount(photoCount)}`);
    }
    setProblem(null);
    setOutcome(null);
    const controller = new AbortController();
    abort.current = controller;
    const { sheet, photos } = picked;
    let importId: string | undefined;
    try {
      const form = new FormData();
      form.set("sheet", sheet, sheet.name);
      form.set("defaultCurrency", currency);
      if (photos.length) form.set("waitForPhotos", "true");
      setProgress({ step: "sheet", sentBytes: 0, totalBytes: sheet.size, sentFiles: 0, totalFiles: photos.length });
      const created = await postForm<{ id: string; alreadyRunning: boolean }>("/api/imports", form, {
        signal: controller.signal,
        onProgress: (sent, total) => setProgress((p) => p && { ...p, sentBytes: sent, totalBytes: total }),
      });
      importId = created.id;
      if (created.alreadyRunning) {
        setOutcome({ kind: "already-running", importId });
        return;
      }
      onChanged();

      let result: PhotoResult | undefined;
      if (photos.length) {
        result = { added: 0, alreadyUploaded: 0, refused: [] };
        const total = photos.reduce((sum, p) => sum + p.size, 0);
        let sentBytes = 0;
        let sentFiles = 0;
        setProgress({ step: "photos", sentBytes: 0, totalBytes: total, sentFiles: 0, totalFiles: photos.length });
        for (const batch of photoBatches(photos)) {
          const batchBytes = batch.reduce((sum, p) => sum + p.size, 0);
          const answer = await withRetries(() => {
            const body = new FormData();
            for (const file of batch) body.append("photos", file, file.name);
            return postForm<PhotoResult>(`/api/imports/${importId}/photos`, body, {
              signal: controller.signal,
              onProgress: (sent, size) => setProgress((p) => p && { ...p, sentBytes: sentBytes + (size ? (sent / size) * batchBytes : 0) }),
            });
          }, controller.signal);
          result.added += answer.added;
          result.alreadyUploaded += answer.alreadyUploaded;
          result.refused.push(...answer.refused);
          sentBytes += batchBytes;
          sentFiles += batch.length;
          setProgress((p) => p && { ...p, sentBytes, sentFiles });
        }
        setProgress((p) => p && { ...p, step: "starting" });
        await withRetries(() => postJson(`/api/imports/${importId}/start`), controller.signal);
      }
      setOutcome({ kind: "started", importId, photos: result });
      setPicked(EMPTY);
    } catch (err) {
      if ((err as Error).name === "AbortError") setOutcome({ kind: "stopped", importId });
      else setOutcome({ kind: "error", importId, message: err instanceof ApiError ? err.message : "Something went wrong. Try again" });
    } finally {
      abort.current = null;
      setProgress(null);
      onChanged();
    }
  }

  return (
    <section aria-labelledby="new-import" className="rounded-lg border border-border bg-card p-4 md:p-6">
      <h2 id="new-import" className="text-base font-semibold">
        New import
      </h2>
      <p id={ids.help} className="mt-1 text-sm text-muted-foreground">
        One CSV or Excel sheet (up to {formatBytes(LIMITS.sheetBytes)}), with its photos: JPEG, PNG or WebP files up to {formatBytes(LIMITS.photoBytes)} each, a
        folder, or ZIPs. Up to {formatCount(LIMITS.photosPerImport)} photos per import.
      </p>

      <div
        className="mt-4"
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging((d) => d + 1);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setDragging((d) => Math.max(0, d - 1))}
        onDrop={onDrop}
      >
        <input
          id={ids.files}
          type="file"
          multiple
          disabled={busy}
          aria-describedby={ids.help}
          accept=".csv,.xlsx,.xls,.jpg,.jpeg,.png,.webp,.zip,.heic,.heif"
          className="peer sr-only"
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <label
          htmlFor={ids.files}
          className={`flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:cursor-not-allowed peer-disabled:opacity-60 ${
            dragging ? "border-info bg-info-soft" : "border-muted-foreground/40 hover:bg-muted"
          }`}
        >
          <svg aria-hidden viewBox="0 0 24 24" className="size-6 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-sm font-medium">{dragging ? "Drop to add" : "Drop the sheet and its photos here, or choose files"}</span>
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
          <span>Photos in a folder?</span>
          <input
            ref={folderInput}
            id={ids.folder}
            type="file"
            multiple
            disabled={busy}
            className="peer sr-only"
            onChange={(e) => {
              add(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <label htmlFor={ids.folder} className={`cursor-pointer rounded-sm font-medium text-link underline-offset-4 hover:underline peer-focus-visible:ring-2 peer-focus-visible:ring-ring ${busy ? "pointer-events-none opacity-60" : ""}`}>
            Choose a folder
          </label>
        </div>
      </div>

      {(picked.sheet || picked.photos.length > 0 || picked.skipped.length > 0) && (
        <div className="mt-4 space-y-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
            <span className="min-w-0">
              <span className="font-medium">Sheet: </span>
              {picked.sheet ? (
                <span className="break-all">
                  {picked.sheet.name} <span className="text-muted-foreground">({formatBytes(picked.sheet.size)})</span>
                </span>
              ) : (
                <span className="text-warning">none yet. Add a CSV or Excel file</span>
              )}
            </span>
            {picked.sheet && !busy && (
              <button type="button" className={buttonClasses("ghost", "sm")} onClick={() => setPicked((p) => ({ ...p, sheet: null }))}>
                Remove
              </button>
            )}
          </div>
          {picked.photos.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
              <span>
                <span className="font-medium">Photos: </span>
                {[photoCount && `${formatCount(photoCount)} photo${photoCount === 1 ? "" : "s"}`, zipCount && `${zipCount} ZIP${zipCount === 1 ? "" : "s"}`].filter(Boolean).join(" and ")}{" "}
                <span className="text-muted-foreground">({formatBytes(photoBytes)})</span>
              </span>
              {!busy && (
                <button type="button" className={buttonClasses("ghost", "sm")} onClick={() => setPicked((p) => ({ ...p, photos: [] }))}>
                  Remove all
                </button>
              )}
            </div>
          )}
          {picked.skipped.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
              <p className="font-medium text-warning">
                {picked.skipped.length} file{picked.skipped.length === 1 ? "" : "s"} won&apos;t be sent
              </p>
              <ul className="mt-1 space-y-0.5">
                {picked.skipped.slice(0, 8).map((s, i) => (
                  <li key={i} className="break-all">
                    {s.name}: {s.reason}
                  </li>
                ))}
                {picked.skipped.length > 8 && <li>and {picked.skipped.length - 8} more</li>}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.currency} className="text-sm font-medium">
            Currency for prices that don&apos;t say
          </label>
          <select
            id={ids.currency}
            value={currency}
            disabled={busy}
            onChange={(e) => setCurrency(e.target.value)}
            className={`min-h-10 rounded-md border border-border bg-card px-3 text-sm ${focusClasses}`}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          {/* Not greyed out when no sheet is picked yet: a click says what's missing */}
          <button type="button" className={buttonClasses("primary")} onClick={upload} disabled={busy} aria-busy={busy}>
            {progress && <Spinner />}
            {progress ? buttonLabel(progress) : "Start import"}
          </button>
          {busy && (
            <button type="button" className={buttonClasses("secondary")} onClick={() => abort.current?.abort()}>
              Stop
            </button>
          )}
        </div>
      </div>

      <div aria-live="polite" className="mt-4 space-y-3">
        {problem && <p className="text-sm text-danger">{problem}</p>}
        {progress && <UploadProgress progress={progress} />}
        {outcome && <OutcomeMessage outcome={outcome} />}
      </div>
    </section>
  );
}

function buttonLabel(progress: Progress) {
  if (progress.step === "photos") return `Uploading ${formatCount(progress.sentFiles)} of ${formatCount(progress.totalFiles)} files…`;
  return progress.step === "sheet" ? "Uploading the sheet…" : "Starting…";
}

function UploadProgress({ progress }: { progress: Progress }) {
  const text =
    progress.step === "sheet"
      ? "Uploading the sheet"
      : progress.step === "photos"
        ? `Uploading photos: ${formatCount(progress.sentFiles)} of ${formatCount(progress.totalFiles)} files (${formatBytes(progress.sentBytes)} of ${formatBytes(progress.totalBytes)})`
        : "Starting the import";
  return (
    <div className="space-y-1.5">
      <p className="text-sm">{text}</p>
      <Meter value={progress.step === "starting" ? 1 : progress.sentBytes} max={progress.step === "starting" ? 1 : progress.totalBytes} label={text} />
    </div>
  );
}

function OutcomeMessage({ outcome }: { outcome: Outcome }) {
  const details = (id: string) => (
    <Link href={`/imports/${id}`} className={linkClasses}>
      Follow it
    </Link>
  );
  if (outcome.kind === "started") return <StartedImport importId={outcome.importId} photos={outcome.photos} />;
  if (outcome.kind === "already-running") {
    return (
      <p className="rounded-md border border-info/40 bg-info-soft px-3 py-2 text-sm">
        This sheet is already being imported. {details(outcome.importId)}
      </p>
    );
  }
  if (outcome.kind === "stopped") {
    return (
      <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
        Upload stopped.{" "}
        {outcome.importId ? "The sheet is saved and waits for its photos: start it from the list below, or upload again." : "Nothing was saved."}
      </p>
    );
  }
  return (
    <div role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm">
      <p className="font-medium text-danger">The upload didn&apos;t go through</p>
      <p className="mt-1">{outcome.message}</p>
      {outcome.importId && <p className="mt-1">The sheet is saved and waits for its photos: you can start it from the list below.</p>}
    </div>
  );
}

// The import just started, followed live right here: what it's doing now, then how it went and what to do next
function StartedImport({ importId, photos }: { importId: string; photos?: PhotoResult }) {
  const { state } = useLiveSummary(importId);
  const summary = state.status === "ready" ? state.summary : null;
  const photoText = summary && photosLine(summary);
  const viewImport = (
    <Link href={`/imports/${importId}`} className={buttonClasses("secondary", "sm")}>
      View import
    </Link>
  );

  let body: ReactNode;
  let box = "border-info/40 bg-info-soft";
  if (summary?.status === "done") {
    const next = nextStep(summary);
    box = "border-success/40 bg-success-soft";
    body = (
      <>
        <p className="flex flex-wrap items-center gap-x-2">
          <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="size-4 shrink-0 text-success">
            <path d="m5 12 5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="font-medium text-success">Import finished</span>
          <span>· {rowsLine(summary)}</span>
        </p>
        {/* New products, and ones already in the catalog that this file updated */}
        {summary.products > 0 && <p className="mt-1">{productsLine(summary)}</p>}
        {photoText && <p className="mt-1">{photoText}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={next.href} className={buttonClasses("primary", "sm")}>
            {next.label}
          </Link>
          {viewImport}
        </div>
      </>
    );
  } else if (summary?.status === "failed") {
    box = "border-danger/40 bg-danger-soft";
    body = (
      <>
        <p className="font-medium text-danger">The file couldn&apos;t be imported</p>
        <p className="mt-1">{asSentence(summary.error ?? "Fix the file and upload it again")}</p>
        <div className="mt-3">{viewImport}</div>
      </>
    );
  } else {
    body = (
      <>
        <p className="flex items-center gap-2 font-medium">
          <Spinner className="text-info" />
          <span className="break-all">Processing {summary?.fileName ?? "the sheet"}</span>
        </p>
        <p className="mt-1">
          {!summary ? "Starting…" : summary.status === "paused" ? `Paused, ${resumingIn(summary.pausedUntil)}. Nothing is lost: it carries on by itself.` : nowDoing(summary)}
        </p>
        {photoText && <p className="mt-1">{photoText}</p>}
        <p className="mt-1 text-muted-foreground">You can leave this page: it keeps going in the background.</p>
        <div className="mt-3">{viewImport}</div>
      </>
    );
  }

  const refused = photos?.refused ?? [];
  return (
    <div className={`rounded-md border px-3 py-2.5 text-sm ${box}`}>
      {body}
      {refused.length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <p className="font-medium">
            {refused.length} photo{refused.length === 1 ? " was" : "s were"} refused:
          </p>
          <ul className="mt-1 space-y-0.5">
            {refused.slice(0, 8).map((r, i) => (
              <li key={i} className="break-all">
                {r.fileName}: {r.reason}
              </li>
            ))}
            {refused.length > 8 && <li>and {refused.length - 8} more (see the import&apos;s photo report)</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
