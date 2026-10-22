import { z } from "zod";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Up to 3 days, the charts go by the hour; longer, by the day
const HOURLY_UP_TO = 3 * DAY;

export const windowQuery = z
  .object({
    days: z.coerce.number().int().min(1).max(366).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((q) => !(q.days && (q.from || q.to)), { message: "Use either days, or from and to, not both" })
  .refine((q) => !q.to || q.from, { message: "to needs a from" });

export type MetricsWindow = { from: Date; to: Date; bucket: "hour" | "day" };

// The period the numbers are for: the last 7 days by default, the last N days, or from..to (to defaults to now)
export function metricsWindow(query: z.infer<typeof windowQuery>, now = new Date()): MetricsWindow | { error: string } {
  const to = query.to ?? now;
  const from = query.from ?? new Date(to.getTime() - (query.days ?? 7) * DAY);
  if (from >= to) return { error: "from must be before to" };
  if (to.getTime() - from.getTime() > 366 * DAY) return { error: "The period can be at most 366 days" };
  return { from, to, bucket: to.getTime() - from.getTime() <= HOURLY_UP_TO ? "hour" : "day" };
}

// The start of the hour or day (UTC) a moment falls in
export function bucketStart(at: Date, bucket: "hour" | "day"): Date {
  const start = new Date(at);
  start.setUTCMinutes(0, 0, 0);
  if (bucket === "day") start.setUTCHours(0);
  return start;
}

// Every bucket in the period, so a chart shows quiet hours as zero instead of skipping them
export function bucketsBetween(window: MetricsWindow): Date[] {
  const step = window.bucket === "hour" ? HOUR : DAY;
  const buckets: Date[] = [];
  for (let at = bucketStart(window.from, window.bucket).getTime(); at < window.to.getTime(); at += step) buckets.push(new Date(at));
  return buckets;
}
