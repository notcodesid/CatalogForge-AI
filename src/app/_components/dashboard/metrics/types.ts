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
  translations: { products: number; languages: TranslationLanguage[]; outOfDate: number };
};
