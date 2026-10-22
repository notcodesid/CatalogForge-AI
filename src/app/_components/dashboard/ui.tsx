import type { ReactNode } from "react";

// Small building blocks shared by the dashboard tabs. Colors come from the tokens in globals.css

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "paused";

const TONES: Record<Tone, { badge: string; bar: string; dot: string }> = {
  neutral: { badge: "bg-muted text-muted-foreground", bar: "bg-muted-foreground/40", dot: "bg-muted-foreground/60" },
  info: { badge: "bg-info-soft text-info", bar: "bg-info", dot: "bg-info" },
  success: { badge: "bg-success-soft text-success", bar: "bg-success", dot: "bg-success" },
  warning: { badge: "bg-warning-soft text-warning", bar: "bg-warning", dot: "bg-warning" },
  danger: { badge: "bg-danger-soft text-danger", bar: "bg-danger", dot: "bg-danger" },
  paused: { badge: "bg-paused-soft text-paused", bar: "bg-paused", dot: "bg-paused" },
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${TONES[tone].badge}`}>{children}</span>;
}

export function Dot({ tone }: { tone: Tone }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${TONES[tone].dot}`} />;
}

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function buttonClasses(variant: "primary" | "secondary" | "ghost" = "secondary", size: "md" | "sm" = "md") {
  // 40 px tall on touch screens (the smallest comfortable tap), a little tighter on desktop
  const sizes = size === "sm" ? "min-h-10 px-3 text-sm sm:min-h-9" : "min-h-10 px-4 text-sm";
  const variants = {
    primary: "bg-primary text-primary-foreground hover:opacity-90",
    secondary: "border border-border bg-card text-foreground hover:bg-muted",
    ghost: "text-foreground hover:bg-muted",
  };
  return `inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${FOCUS} ${sizes} ${variants[variant]}`;
}

export const linkClasses = `rounded-sm font-medium text-link underline-offset-4 hover:underline ${FOCUS}`;
export const focusClasses = FOCUS;

// One bar split into parts (done / to review / failed / waiting), with the numbers read out to screen readers
export function ProgressBar({ segments, label }: { segments: { value: number; tone: Tone }[]; label: string }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <div role="img" aria-label={label} className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      {total > 0 &&
        segments
          .filter((s) => s.value > 0)
          .map((s, i) => <div key={i} className={`h-full transition-[width] duration-500 motion-reduce:transition-none ${TONES[s.tone].bar}`} style={{ width: `${(s.value / total) * 100}%` }} />)}
    </div>
  );
}

// A plain bar for "how much is done" (bytes sent, files sent)
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-info transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-muted motion-reduce:animate-none ${className}`} />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function ErrorState({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-danger">{title}</p>
        <p className="text-sm text-foreground">{message}</p>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className={buttonClasses("secondary", "sm")}>
          Try again
        </button>
      )}
    </div>
  );
}
