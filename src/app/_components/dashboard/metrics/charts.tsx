"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Dot, focusClasses, type Tone } from "../ui";
import { columnLayout, columnPath, niceScale, type Segment, share } from "./helpers";

// The Metrics tab's charts, drawn with plain SVG and CSS. The look follows a few fixed rules: thin marks, columns
// at most 24 px wide with a 4 px rounded end, hairline gridlines, labels in text colors (never the series color),
// a table view for every chart, and the same details on keyboard focus as on hover

// The one series color (blue), with a darker-surface step for dark mode. Checked for contrast against our cards
const SERIES_FILL = "fill-[#2a78d6] dark:fill-[#3987e5]";
const SERIES_BG = "bg-[#2a78d6] dark:bg-[#3987e5]";
// A second series, only where two must be told apart (orange: validated next to the blue, light and dark)
const SECOND_BG = "bg-[#eb6834] dark:bg-[#d95926]";

const TONE_BG: Record<Tone, string> = {
  neutral: "bg-muted-foreground/40",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  paused: "bg-paused",
};

// A chart with its title, a sentence on how to read it, and its numbers as a table one click away
export function ChartFrame({ title, description, table, children }: { title: string; description?: ReactNode; table?: ReactNode; children: ReactNode }) {
  return (
    <figure className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <figcaption className="space-y-0.5">
        <span className="block text-sm font-semibold">{title}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </figcaption>
      {children}
      {table && (
        <details className="group text-sm">
          <summary className={`w-fit cursor-pointer rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground ${focusClasses}`}>
            <span className="group-open:hidden">Show as a table</span>
            <span className="hidden group-open:inline">Hide the table</span>
          </summary>
          <div className="mt-2 max-h-72 overflow-auto">{table}</div>
        </details>
      )}
    </figure>
  );
}

// A simple table for a chart's numbers: first column left, the rest right-aligned with figures that line up
export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-muted-foreground">
        <tr>
          {head.map((h, i) => (
            <th key={h} scope="col" className={`py-1.5 pr-3 font-medium ${i > 0 ? "text-right" : ""}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, i) => (
              <td key={i} className={`py-1.5 pr-3 ${i > 0 ? "text-right tabular-nums" : ""}`}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ChartEmpty({ children }: { children: ReactNode }) {
  return <p className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-border px-4 text-center text-sm text-muted-foreground">{children}</p>;
}

// The chart's width in pixels, so text stays crisp (a stretched SVG would stretch its labels too)
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export type Column = {
  key: string;
  // Under the axis, e.g. "14:00" or "Oct 22"
  label: string;
  // The tooltip's heading, e.g. "Oct 22, 14:00–15:00 UTC"
  detail: string;
  value: number;
  // More lines for the tooltip ("3 calls", "1.2K tokens in")
  lines?: string[];
};

const PLOT_HEIGHT = 168;
const AXIS_BAND = 24;
const LEFT = 56;
const TOP = 8;

// Columns over time (one series). Hover a column, or focus the chart and use the arrow keys, to read a value:
// the readout also goes to screen readers. Every column is in the table view too
export function ColumnChart({ columns, format, label }: { columns: Column[]; format: (value: number) => string; label: string }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const plotWidth = Math.max(0, width - LEFT - 8);
  const scale = niceScale(Math.max(...columns.map((c) => c.value), 0));
  const { slot, barWidth, offset } = columnLayout(columns.length, plotWidth);
  const y = (value: number) => TOP + PLOT_HEIGHT - (value / scale.max) * PLOT_HEIGHT;
  // Every label needs about 44 px; on a narrow screen only every few columns is named
  const every = Math.max(1, Math.ceil((columns.length * 44) / Math.max(plotWidth, 1)));
  const current = active === null ? null : columns[active];

  const onKeyDown = (event: KeyboardEvent) => {
    const last = columns.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: Math.min(last, (active ?? -1) + 1),
      ArrowLeft: Math.max(0, (active ?? columns.length) - 1),
      Home: 0,
      End: last,
    };
    if (event.key in moves) {
      event.preventDefault();
      setActive(moves[event.key]);
    } else if (event.key === "Escape") {
      setActive(null);
    }
  };

  return (
    <div
      ref={ref}
      role="group"
      aria-label={`${label}. Use the arrow keys to read each value`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => setActive((a) => a ?? columns.length - 1)}
      onBlur={() => setActive(null)}
      onMouseLeave={() => setActive(null)}
      className={`relative w-full rounded-md ${focusClasses}`}
    >
      {width > 0 && (
        <svg width={width} height={TOP + PLOT_HEIGHT + AXIS_BAND} aria-hidden className="block overflow-visible">
          {scale.ticks.map((tick) => (
            <g key={tick}>
              <line x1={LEFT} x2={LEFT + plotWidth} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={LEFT - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                {format(tick)}
              </text>
            </g>
          ))}
          {columns.map((column, i) => {
            const x = LEFT + i * slot;
            const top = y(column.value);
            return (
              <g key={column.key}>
                <path d={columnPath(x + offset, top, barWidth, TOP + PLOT_HEIGHT - top)} className={`${SERIES_FILL} transition-opacity ${active === i ? "opacity-70" : ""}`} />
                {/* The whole slot answers the pointer, not just the column: a thin column is hard to hit */}
                <rect x={x} y={TOP} width={slot} height={PLOT_HEIGHT} fill="transparent" onMouseEnter={() => setActive(i)} onMouseMove={() => setActive(i)} />
                {i % every === 0 && (
                  <text x={x + slot / 2} y={TOP + PLOT_HEIGHT + 16} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                    {column.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {width === 0 && <div style={{ height: TOP + PLOT_HEIGHT + AXIS_BAND }} />}
      {current && active !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-max max-w-56 -translate-x-1/2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: Math.min(Math.max(LEFT + active * slot + slot / 2, 90), Math.max(width - 90, 90)) }}
        >
          <p className="text-sm font-semibold">{format(current.value)}</p>
          <p className="text-muted-foreground">{current.detail}</p>
          {current.lines?.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {current ? `${current.detail}: ${format(current.value)}${current.lines?.length ? `, ${current.lines.join(", ")}` : ""}` : ""}
      </p>
    </div>
  );
}

export type Bar = { key: string; label: string; value: number; display: string; details?: string };

// Horizontal bars for one measure (cost per model, per kind of work). Every value is written next to its bar,
// so nothing is hidden behind a hover
export function BarList({ bars }: { bars: Bar[] }) {
  const max = Math.max(...bars.map((b) => b.value), 0);
  return (
    <ul className="space-y-3">
      {bars.map((bar) => (
        <li key={bar.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium">{bar.label}</span>
            <span className="shrink-0 font-semibold">{bar.display}</span>
          </div>
          <div className="mt-1.5 h-3 w-full" aria-hidden>
            {bar.value > 0 && <div className={`h-full rounded-r-[4px] ${SERIES_BG}`} style={{ width: `max(2px, ${share(bar.value, max)}%)` }} />}
          </div>
          {bar.details && <p className="mt-1 text-xs text-muted-foreground">{bar.details}</p>}
        </li>
      ))}
    </ul>
  );
}

export type Range = { key: string; label: string; low: number | null; high: number | null; lowText: string; highText: string };

// Average and slowest side by side on one time axis (a dumbbell per model). The numbers are written out too
export function RangeList({ ranges, lowLabel, highLabel, format }: { ranges: Range[]; lowLabel: string; highLabel: string; format: (value: number) => string }) {
  const scale = niceScale(Math.max(...ranges.map((r) => r.high ?? r.low ?? 0), 0), 3);
  const at = (value: number) => `${share(value, scale.max)}%`;
  return (
    <div className="space-y-4">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={`inline-block size-2.5 rounded-full ${SERIES_BG}`} /> {lowLabel}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={`inline-block size-2.5 rounded-full ${SECOND_BG}`} /> {highLabel}
        </li>
      </ul>
      <ul className="space-y-4">
        {ranges.map((range) => (
          <li key={range.key} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="min-w-0 truncate font-medium">{range.label}</span>
              <span className="text-xs text-muted-foreground">
                {lowLabel} <span className="font-semibold text-foreground">{range.lowText}</span> · {highLabel}{" "}
                <span className="font-semibold text-foreground">{range.highText}</span>
              </span>
            </div>
            <div className="relative h-4" aria-hidden>
              <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
              {range.low !== null && range.high !== null && (
                <div className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-muted-foreground/50" style={{ left: at(range.low), width: `${share(range.high - range.low, scale.max)}%` }} />
              )}
              {range.high !== null && <span className={`absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card ${SECOND_BG}`} style={{ left: at(range.high) }} />}
              {range.low !== null && <span className={`absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card ${SERIES_BG}`} style={{ left: at(range.low) }} />}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums" aria-hidden>
        {scale.ticks.map((tick) => (
          <span key={tick}>{format(tick)}</span>
        ))}
      </div>
    </div>
  );
}

// One bar split into parts that make up a whole (rows by status, a language's coverage), each part with its
// color, name and number in the legend: color is never the only way to tell them apart
export function SegmentBar({ segments, label }: { segments: Segment[]; label: string }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const shown = segments.filter((s) => s.value > 0);
  return (
    <div className="space-y-2">
      <div role="img" aria-label={`${label}: ${segments.map((s) => `${s.label} ${s.value}`).join(", ")}`} className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px] bg-muted">
        {total > 0 && shown.map((s) => <div key={s.key} className={`h-full ${TONE_BG[s.tone]}`} style={{ flexGrow: s.value, flexBasis: 0 }} />)}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <Dot tone={s.tone} />
            {s.label}
            <span className="font-medium text-foreground tabular-nums">{s.value.toLocaleString("en")}</span>
            {total > 0 && <span className="tabular-nums">({Math.round(share(s.value, total))}%)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
