// What the dashboard reads from and sends to the API. The shapes mirror the route handlers' JSON (dates arrive as
// strings). Kept separate from the server modules on purpose: importing those here would ship database code to
// the browser

export type ImportStatus = "waiting_for_files" | "queued" | "running" | "paused" | "done" | "failed";
export type RowStatus = "pending" | "processing" | "done" | "needs_review" | "failed";
export type PhotoStatus = "pending" | "matched" | "unmatched" | "rejected";

export type RowCounts = Record<RowStatus, number>;
export type TranslationCounts = Record<string, { done: number; pending: number; failed: number; withProblems?: number }>;

type PhotoCounts = Record<PhotoStatus, number> & { total: number; waitingToBeProcessed: number; linksOverLimit: number };

export type ImportListItem = {
  id: string;
  fileName: string;
  status: ImportStatus;
  stage: string | null;
  phase: string;
  pausedUntil: string | null;
  pauseReason: string | null;
  error: string | null;
  totalRows: number | null;
  rows: RowCounts;
  products: number;
  // In the list, "missing" is how many files the sheet names that weren't uploaded
  photos: PhotoCounts & { missing: number };
  translations: TranslationCounts;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type MissingPhoto = { file: string; rows: number[] };

export type ParseInfo = {
  fileType: string;
  encoding?: string;
  delimiter?: string;
  sheetName?: string;
  headerRow: number;
  columns: Record<string, string>;
  unmappedColumns: string[];
  blankRows: number;
  format: string;
  optionColumns: { name: string; value: string }[];
  ignoredRows: { rowNumber: number; text: string }[];
};

export type ImportSummary = Omit<ImportListItem, "photos"> & {
  photos: PhotoCounts & { missing: MissingPhoto[] };
  defaultCurrency: string;
  rowsWithReviewIssues: number;
  productsByStatus: Record<string, number>;
  parseInfo: ParseInfo | null;
};

export type ImportRow = {
  rowNumber: number;
  status: RowStatus;
  reason: string | null;
  productKey: string | null;
  raw: Record<string, string>;
  cleaned: {
    sku: string | null;
    title: string | null;
    priceCents: number | null;
    currency: string | null;
    size: string | null;
    color: string | null;
    role: string;
    issues: { severity: "review" | "info"; message: string }[];
  } | null;
};

export type ImportPhoto = {
  id: string;
  fileName: string;
  status: PhotoStatus;
  reason: string | null;
  assignedByHand: boolean;
  sourceUrl: string | null;
  sku: string | null;
  rowNumber: number | null;
  productId: string | null;
  productTitle: string | null;
  processed: boolean;
  width: number | null;
  height: number | null;
  url?: string;
  thumbnailUrl?: string;
};

export type RetryResult = { rowsRetried: number; translationsRetried: number; translationBatches: number; rowsNotRetryable: number };

// An answer the API sent with an error message meant for the merchant
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorFrom(status: number, body: unknown): ApiError {
  const message = (body as { error?: unknown } | null)?.error;
  return new ApiError(typeof message === "string" ? message : `The server answered ${status}. Try again in a moment`, status);
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Can't reach the server. Check your connection", 0);
  }
  const body = await readBody(res);
  if (!res.ok) throw errorFrom(res.status, body);
  return body as T;
}

// Sends JSON with any method and reads the answer. The API's own error message (meant for the merchant) is kept
export async function sendJson<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection", 0);
  }
  const answer = await readBody(res);
  if (!res.ok) throw errorFrom(res.status, answer);
  return answer as T;
}

export const postJson = <T>(url: string, body?: object) => sendJson<T>("POST", url, body);

export const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : "Something went wrong. Try again");

// Sends a form and reports how many bytes have gone out. fetch() can't report upload progress, XMLHttpRequest can
export function postForm<T>(url: string, form: FormData, options: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {}) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON (a proxy's error page): the status says enough
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(errorFrom(xhr.status, body));
    };
    xhr.onerror = () => reject(new ApiError("The upload was interrupted. Check your connection and try again", 0));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    options.signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}
