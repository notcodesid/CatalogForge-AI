import type { ImportStatus } from "../api";

// What GET /api/metrics answers (src/server/metrics/metrics.ts). Mirrored here rather than imported, so no
// database code ends up in the browser. Money is in dollars, times in ms or seconds as named

export type Bucket = "hour" | "day";

export type ImportStat = {
  id: string;
  fileName: string;
  status: ImportStatus;
  createdAt: string;
  rows: number;
  products: number;
  // How long a finished import took, null while it runs (or if it failed)
  seconds: number | null;
  rowsPerMinute: number | null;
  aiCalls: number;
  costUsd: number;
  costPerProductUsd: number | null;
};

export type CallTotals = {
  calls: number;
  // Answered from a saved answer, for free
  cacheHits: number;
  products: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costPerProductUsd: number | null;
};

export type ModelUsage = CallTotals & { provider: string; model: string; averageLatencyMs: number | null; slowestLatencyMs: number | null };

export type TranslationLanguage = {
  locale: string;
  // Shown to shoppers in some country right now
  enabled: boolean;
  done: number;
  pending: number;
  failed: number;
  // Done, but at least one field is shown in English because the AI's translation failed a check
  withProblems: number;
  merchantFixes: number;
  outOfDate: number;
  translated: number;
  // Percent of the catalog fully translated
  coverage: number;
};

export type Saving = { usd: number; note: string };

// One kind of reason products wait for review, e.g. every 'Row 12: Weight "2,8" has no unit (kg, g or lbs?)'
export type ReviewReason = {
  key: string;
  // "Weight has no unit", "AI unsure: category", "The AI's own doubt"
  label: string;
  products: number;
  // Percent of all products in review
  share: number;
  // One real reason of this kind, as one product has it
  example: { reason: string; productId: string };
};

export type Metrics = {
  window: { from: string; to: string; bucket: Bucket };
  products: {
    processed: number;
    catalog: { total: number; ready: number; needsReview: number; approved: number; deleted: number };
    rates: { ready: number; needsReview: number; approved: number };
  };
  rows: { total: number; done: number; needsReview: number; failed: number; pending: number; rates: { done: number; needsReview: number; failed: number } };
  imports: {
    total: number;
    byStatus: Record<ImportStatus, number>;
    speed: { averageSeconds: number | null; rowsPerMinute: number | null; slowest: { id: string; fileName: string; rows: number; seconds: number } | null };
    recent: ImportStat[];
    topByCost: ImportStat[];
  };
  ai: CallTotals & {
    costPer1000ProductsUsd: number | null;
    answeredCalls: number;
    byModel: ModelUsage[];
    byPurpose: (CallTotals & { purpose: string })[];
    problems: { rateLimited: number; timeout: number; invalidOutput: number; error: number };
    overTime: { at: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[];
  };
  savings: {
    totalUsd: number;
    cache: Saving & { calls: number };
    routing: Saving & { calls: number };
    batching: Saving & { extraInstructionTokens: number };
  };
  // The products waiting for review now (not for the period): how many, and the most common kinds of reason
  reviewReasons: { total: number; withoutReason: number; kinds: number; top: ReviewReason[] };
  translations: { products: number; languages: TranslationLanguage[]; outOfDate: number };
};
