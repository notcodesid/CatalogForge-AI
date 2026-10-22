import type { Queue } from "pg-boss";

type QueueSettings = Omit<Queue, "name">;

// Every queue the app uses, with its retry/timeout settings. The worker copies these settings into the
// database on every start (see syncQueues), so changing a number here really changes the queue.
// Order matters: a dead-letter queue has to exist before the queue that points to it
export const queues = {
  // Test job: proves the API -> queue -> worker path works
  ping: { name: "ping", options: { retryLimit: 0, expireInSeconds: 60 } },

  // Parse jobs that used up all their tries end up here, so the import can be marked Failed
  parseImportDead: { name: "parse-import-dead", options: { retryLimit: 2, retryDelay: 5 } },

  // Reads, cleans and groups an uploaded sheet
  parseImport: {
    name: "parse-import",
    options: {
      // "exclusive": at most one job per import waiting or running at any time (the import id is the key)
      policy: "exclusive",
      // A crash or a database hiccup gets 3 more tries: after ~5s, ~10s, ~20s
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      // The worker checks in every 7.5s. If it goes quiet for 15s (killed, frozen), the job is handed out again
      heartbeatSeconds: 15,
      expireInSeconds: 15 * 60,
      deadLetter: "parse-import-dead",
    },
  },

  // AI batches that failed every try end up here, so their rows can be marked Failed
  buildBatchDead: { name: "build-batch-dead", options: { retryLimit: 2, retryDelay: 5 } },

  // Sends about 10 products to the AI, checks the answer and saves the products
  buildBatch: {
    name: "build-batch",
    options: {
      // One job per batch at a time (the key is the import id + the batch's products)
      policy: "exclusive",
      // AI hiccups get 3 more tries: after ~10s, ~20s, ~40s
      retryLimit: 3,
      retryDelay: 10,
      retryBackoff: true,
      heartbeatSeconds: 30,
      expireInSeconds: 10 * 60,
      deadLetter: "build-batch-dead",
    },
  },

  // Photo batches that failed every try end up here, so their photos can be marked Rejected
  processPhotosDead: { name: "process-photos-dead", options: { retryLimit: 2, retryDelay: 5 } },

  // Checks and resizes about 50 uploaded photos (see photos/process.ts)
  processPhotos: {
    name: "process-photos",
    options: {
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      heartbeatSeconds: 30,
      expireInSeconds: 10 * 60,
      deadLetter: "process-photos-dead",
    },
  },

  // Translation batches that failed every try end up here, so their products can be marked as failed
  translateBatchDead: { name: "translate-batch-dead", options: { retryLimit: 2, retryDelay: 5 } },

  // Translates about 10 products into one language (see translations/run.ts)
  translateBatch: {
    name: "translate-batch",
    options: {
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 10,
      retryBackoff: true,
      heartbeatSeconds: 30,
      expireInSeconds: 10 * 60,
      deadLetter: "translate-batch-dead",
    },
  },

  // Runs every minute: finds imports whose job has gone missing and restarts them
  watchdog: { name: "watchdog", options: { retryLimit: 0, expireInSeconds: 60 } },
} satisfies Record<string, { name: string; options: QueueSettings }>;

export type PingJob = { sentAt: string };
export type PingResult = { pongAt: string; waitedMs: number };

export type ParseImportJob = { importId: string };

export type ProcessPhotosJob = { importId: string; photoIds: string[] };

export type TranslateBatchJob = {
  // The import these products came from, or "catalog" (a language switched on later, a merchant's edit)
  scope: string;
  importId: string | null;
  locale: "de" | "fr";
  productIds: string[];
};

export type BuildBatchJob = {
  importId: string;
  productKeys: string[];
  // "cheap" or "strong" model, see pipeline/build.ts
  tier: "cheap" | "strong";
  // These products already have a listing and this file has nothing new to say about them: keep the listing,
  // only update prices and variants, don't ask the AI (see listingsToKeep in pipeline/build.ts)
  keepListing?: boolean;
};
