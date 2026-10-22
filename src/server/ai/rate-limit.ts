import { sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { aiStatus } from "@/server/db/schema";

// The AI is paused for longer than a job should sit and wait. The batch is put back in the queue to start
// at `until`, and doesn't count as a failed try
export class AiPausedError extends Error {
  constructor(
    readonly until: Date,
    reason: string,
  ) {
    super(reason);
  }
}

// Waiting longer than this inside a job isn't worth it: the batch goes back to the queue instead
const MAX_WAIT_IN_JOB_MS = 90_000;

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

// Takes the next free time slot for a call to this provider and waits for it. All workers share the slots
// through the database, so together they never go over requestsPerMinute. A pause (after a "too many
// requests" answer) pushes every slot past the end of the pause
export async function waitForTurn(
  db: Db,
  provider: string,
  options: { requestsPerMinute?: number; signal?: AbortSignal },
) {
  const spacingMs = options.requestsPerMinute ? Math.ceil(60_000 / options.requestsPerMinute) : 0;
  const spacing = sql`make_interval(secs => ${spacingMs / 1000})`;
  const result = await db.execute<{ slot: Date; reason: string | null }>(sql`
    insert into ${aiStatus} (provider, next_call_at, updated_at) values (${provider}, now() + ${spacing}, now())
    on conflict (provider) do update set
      next_call_at = greatest(${aiStatus.nextCallAt}, now(), coalesce(${aiStatus.pausedUntil}, now())) + ${spacing},
      updated_at = now()
    returning next_call_at - ${spacing} as slot, case when paused_until > now() then reason end as reason
  `);
  const { slot, reason } = result.rows[0];
  const waitMs = new Date(slot).getTime() - Date.now();
  if (waitMs > MAX_WAIT_IN_JOB_MS) {
    throw new AiPausedError(new Date(slot), reason ?? "Waiting for the AI's rate limit");
  }
  await sleep(waitMs, options.signal);
}

// The provider said "too many requests" (or the account is out of credit): every worker waits until `until`
export async function pauseProvider(db: Db, provider: string, until: Date, reason: string) {
  await db
    .insert(aiStatus)
    .values({ provider, pausedUntil: until, reason })
    .onConflictDoUpdate({
      target: aiStatus.provider,
      set: { pausedUntil: sql`greatest(${aiStatus.pausedUntil}, ${until.toISOString()}::timestamptz)`, reason, updatedAt: new Date() },
    });
}
