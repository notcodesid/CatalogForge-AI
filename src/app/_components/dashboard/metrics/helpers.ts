import { formatDuration } from "../format";
import type { Tone } from "../ui";
import type { Bucket, TranslationLanguage } from "./types";

// Pure helpers for the Metrics tab: the period in the address, number formats and chart geometry. Kept apart
// from the components so they can be tested without a browser

export const PERIODS = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

export type PeriodDays = (typeof PERIODS)[number]["days"];
const DEFAULT_DAYS: PeriodDays = 7;

// ?days=30 in the address. Anything else (missing, a typo, 9) falls back to 7 days instead of an error page
export function periodFromParam(value: string | null): PeriodDays {
  return PERIODS.find((p) => String(p.days) === value)?.days ?? DEFAULT_DAYS;
}

// "the last 24 hours", "the last 7 days"
export function periodPhrase(days: PeriodDays) {
  return `the last ${PERIODS.find((p) => p.days === days)!.label}`;
}

// Money as people read it. AI costs are often fractions of a cent, so small amounts keep two significant digits:
// $12.40, $0.16, $0.044, $0.0086, $0.0001
export function formatUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "–";
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  const options: Intl.NumberFormatOptions =
    abs >= 1
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : abs >= 0.01
        ? { minimumFractionDigits: 2, maximumFractionDigits: 3 }
        : { maximumSignificantDigits: 2 };
  return new Intl.NumberFormat("en", { style: "currency", currency: "USD", ...options }).format(value);
}

// 980, 12.9K, 1.2M
export function formatCompact(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

// 68.6%
export function formatPercent(value: number) {
  return `${value.toLocaleString("en", { maximumFractionDigits: 1 })}%`;
}

// 830 ms, 2.1 s, 1 min 4 s
export function formatLatency(ms: number | null) {
  if (ms === null) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  return formatDuration(ms);
}

// The API's buckets start on the hour or at midnight in UTC, so they're named in UTC too: a chart doesn't shift
// by a day depending on where it's opened
export function bucketLabel(iso: string, bucket: Bucket) {
  const at = new Date(iso);
  return bucket === "hour"
    ? new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(at)
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(at);
}

// "Oct 22, 14:00–15:00 UTC" or "Thu, Oct 22 (UTC)", for tooltips and the table view
export function bucketRangeLabel(iso: string, bucket: Bucket) {
  const at = new Date(iso);
  if (bucket === "day") return `${new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(at)} (UTC)`;
  const end = new Date(at.getTime() + 60 * 60 * 1000);
  const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(at);
  return `${day}, ${bucketLabel(iso, "hour")}–${bucketLabel(end.toISOString(), "hour")} UTC`;
}

// An axis that ends on a round number, with evenly spaced round ticks: 0 / 0.0025 / 0.005 ... or 0 / 25 / 50
export function niceScale(max: number, count = 4): { max: number; ticks: number[] } {
  if (!(max > 0) || !Number.isFinite(max)) return { max: 1, ticks: [0, 1] };
  const rough = max / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough * (1 - 1e-9))!;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; i * step <= top * (1 + 1e-9); i++) ticks.push(Number((i * step).toPrecision(12)));
  return { max: Number(top.toPrecision(12)), ticks };
}

// Where each column goes: every slot is the same width, the column sits in its middle and never fills it
// (at most 24 px, so there's air between columns)
export function columnLayout(count: number, width: number) {
  const slot = count > 0 ? width / count : width;
  const barWidth = Math.max(2, Math.min(24, slot * 0.7));
  return { slot, barWidth, offset: (slot - barWidth) / 2 };
}

// A column with a 4 px rounded top and a square bottom (it grows from the baseline). Short columns get a
// smaller radius so the curve never eats more than the column is tall
export function columnPath(x: number, y: number, width: number, height: number, radius = 4) {
  if (height <= 0 || width <= 0) return "";
  const r = Math.min(radius, width / 2, height);
  const bottom = y + height;
  return `M${x},${bottom}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${bottom}Z`;
}

// Share of a whole, for widths and labels. A whole of 0 is 0%, never NaN
export function share(part: number, whole: number) {
  return whole > 0 ? (part / whole) * 100 : 0;
}

export function purposeLabel(purpose: string) {
  if (purpose === "build") return "Writing products";
  if (purpose === "translate") return "Translating";
  return purpose.charAt(0).toUpperCase() + purpose.slice(1);
}

export type Segment = { key: string; label: string; value: number; tone: Tone };

// How a language's translation stands for the whole catalog, part by part (they add up to the catalog)
export function translationSegments(language: TranslationLanguage, products: number): Segment[] {
  const translated = Math.max(0, language.done - language.withProblems);
  const notStarted = Math.max(0, products - language.done - language.pending - language.failed);
  return [
    { key: "translated", label: "Translated", value: translated, tone: "success" },
    { key: "problems", label: "A field shown in English", value: language.withProblems, tone: "warning" },
    { key: "pending", label: "Still to do", value: language.pending, tone: "info" },
    { key: "failed", label: "Failed", value: language.failed, tone: "danger" },
    { key: "notStarted", label: "Not translated", value: notStarted, tone: "neutral" },
  ];
}
