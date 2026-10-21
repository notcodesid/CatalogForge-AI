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

  // Runs every minute: finds imports whose job has gone missing and restarts them
  watchdog: { name: "watchdog", options: { retryLimit: 0, expireInSeconds: 60 } },
} satisfies Record<string, { name: string; options: QueueSettings }>;

export type PingJob = { sentAt: string };
export type PingResult = { pongAt: string; waitedMs: number };

export type ParseImportJob = { importId: string };
