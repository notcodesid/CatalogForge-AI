import Link from "next/link";
import type { ReactNode } from "react";
import { formatCount, formatDuration } from "../format";
import { IMPORT_STATUS, LANGUAGE_NAMES } from "../statuses";
import { Badge, focusClasses, linkClasses, type Tone } from "../ui";
import { BarList, ChartEmpty, ChartFrame, ColumnChart, DataTable, RangeList, SegmentBar } from "./charts";
import { bucketLabel, bucketRangeLabel, formatCompact, formatLatency, formatPercent, formatUsd, type PeriodDays, periodPhrase, purposeLabel, translationSegments } from "./helpers";
import type { ImportStat, Metrics } from "./types";

// The Metrics tab's sections, each drawn from one GET /api/metrics answer

function SectionHeading({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="space-y-1">
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children && <p className="max-w-prose text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

// A number that answers a question on its own: no chart needed
function Stat({ label, value, badge, children }: { label: string; value: ReactNode; badge?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        {badge}
      </div>
      <p className="text-2xl font-semibold tracking-tight">{value}</p>
      {children && <div className="text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

// The headline numbers for the period
export function KeyNumbers({ metrics, days }: { metrics: Metrics; days: PeriodDays }) {
  const { products, rows, ai, savings } = metrics;
  return (
    <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <Stat label="Products processed" value={formatCount(products.processed)}>
        {formatCount(products.catalog.total)} in the catalog now, {formatCount(products.catalog.approved)} approved
      </Stat>
      <Stat label="Rows" value={formatCount(rows.total)}>
        <SegmentBar
          label="How the rows ended"
          segments={[
            { key: "done", label: "Done", value: rows.done, tone: "success" },
            { key: "review", label: "Needs review", value: rows.needsReview, tone: "warning" },
            { key: "failed", label: "Failed", value: rows.failed, tone: "danger" },
            { key: "pending", label: "Waiting", value: rows.pending, tone: "neutral" },
          ]}
        />
      </Stat>
      <Stat label="AI cost" value={formatUsd(ai.costUsd)}>
        {formatCount(ai.calls)} calls in {periodPhrase(days)}, {formatCount(ai.cacheHits)} answered from saved answers for free
      </Stat>
      <Stat label="Cost per 1,000 products" value={formatUsd(ai.costPer1000ProductsUsd)}>
        {ai.costPer1000ProductsUsd === null ? "No products were written in this period" : "Everything the AI did for this period's imports, translations included"}
      </Stat>
      <Stat label="Money saved" value={formatUsd(savings.totalUsd)} badge={<Badge tone="neutral">Estimate</Badge>}>
        <details className="group">
          <summary className={`w-fit cursor-pointer rounded-sm font-medium hover:text-foreground ${focusClasses}`}>How it&apos;s worked out</summary>
          <ul className="mt-2 space-y-2">
            {[
              { title: "Cheap model where it's enough", usd: savings.routing.usd, extra: `${formatCount(savings.routing.calls)} calls`, note: savings.routing.note },
              { title: "10 products per call", usd: savings.batching.usd, extra: `${formatCompact(savings.batching.extraInstructionTokens)} fewer instruction tokens`, note: savings.batching.note },
              { title: "Saved answers", usd: savings.cache.usd, extra: `${formatCount(savings.cache.calls)} calls`, note: savings.cache.note },
            ].map((s) => (
              <li key={s.title}>
                <p className="text-foreground">
                  {s.title}: <span className="font-semibold">{formatUsd(s.usd)}</span> ({s.extra})
                </p>
                <p>{s.note}</p>
              </li>
            ))}
          </ul>
        </details>
      </Stat>
    </section>
  );
}

const PROBLEMS: { key: keyof Metrics["ai"]["problems"]; label: string; explain: string; tone: Tone }[] = [
  { key: "rateLimited", label: "Too many requests", explain: "The AI asked us to slow down. Every worker paused, then the call was asked again", tone: "warning" },
  { key: "timeout", label: "No answer in time", explain: "The AI took longer than 90 seconds. The call was tried again", tone: "warning" },
  { key: "invalidOutput", label: "Answer asked again", explain: "The answer was cut off or not in the shape we need, so it was asked again", tone: "warning" },
  { key: "error", label: "Other errors", explain: "The provider was down or refused. Tried again; rows it kept failing on are marked Failed", tone: "danger" },
];

export function AiSection({ metrics, days }: { metrics: Metrics; days: PeriodDays }) {
  const { ai, window } = metrics;
  const phrase = periodPhrase(days);
  const columns = ai.overTime.map((b) => ({
    key: b.at,
    label: bucketLabel(b.at, window.bucket),
    detail: bucketRangeLabel(b.at, window.bucket),
    value: b.costUsd,
    lines: [`${formatCount(b.calls)} call${b.calls === 1 ? "" : "s"}`, `${formatCompact(b.inputTokens)} tokens in, ${formatCompact(b.outputTokens)} out`],
  }));
  const perProduct = (usd: number | null) => (usd === null ? "" : ` · ${formatUsd(usd)} per product`);

  return (
    <section aria-labelledby="ai-heading" className="space-y-4">
      <SectionHeading id="ai-heading" title="AI cost and use">
        Every call to the AI in {phrase}: what it cost, which model answered and how long it took. Costs are at the provider&apos;s published prices.
      </SectionHeading>

      <ChartFrame
        title={`AI cost per ${window.bucket}`}
        description={`${formatUsd(ai.costUsd)} in ${phrase}. Times in UTC.`}
        table={
          <DataTable
            head={["When", "Cost", "Calls", "Tokens in", "Tokens out"]}
            rows={ai.overTime.map((b) => [bucketRangeLabel(b.at, window.bucket), formatUsd(b.costUsd), formatCount(b.calls), formatCount(b.inputTokens), formatCount(b.outputTokens)])}
          />
        }
      >
        {ai.calls === 0 ? <ChartEmpty>No AI calls in {phrase}</ChartEmpty> : <ColumnChart columns={columns} format={formatUsd} label={`AI cost per ${window.bucket} in ${phrase}`} />}
      </ChartFrame>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartFrame
          title="By model"
          description="Clean products and translations go to the cheap model, messy products to the stronger one"
          table={
            <DataTable
              head={["Model", "Calls", "Saved answers", "Products", "Tokens in", "Tokens out", "Cost"]}
              rows={ai.byModel.map((m) => [m.model, formatCount(m.calls), formatCount(m.cacheHits), formatCount(m.products), formatCount(m.inputTokens), formatCount(m.outputTokens), formatUsd(m.costUsd)])}
            />
          }
        >
          {ai.byModel.length ? (
            <BarList
              bars={ai.byModel.map((m) => ({
                key: `${m.provider}:${m.model}`,
                label: m.model,
                value: m.costUsd,
                display: formatUsd(m.costUsd),
                details: `${formatCount(m.calls)} calls (${formatCount(m.cacheHits)} from saved answers) · ${formatCount(m.products)} products${perProduct(m.costPerProductUsd)}`,
              }))}
            />
          ) : (
            <ChartEmpty>No AI calls in {phrase}</ChartEmpty>
          )}
        </ChartFrame>

        <ChartFrame
          title="By kind of work"
          description="Writing products from the supplier's rows, and translating them"
          table={
            <DataTable
              head={["Work", "Calls", "Saved answers", "Products", "Tokens in", "Tokens out", "Cost"]}
              rows={ai.byPurpose.map((p) => [purposeLabel(p.purpose), formatCount(p.calls), formatCount(p.cacheHits), formatCount(p.products), formatCount(p.inputTokens), formatCount(p.outputTokens), formatUsd(p.costUsd)])}
            />
          }
        >
          {ai.byPurpose.length ? (
            <BarList
              bars={ai.byPurpose.map((p) => ({
                key: p.purpose,
                label: purposeLabel(p.purpose),
                value: p.costUsd,
                display: formatUsd(p.costUsd),
                details: `${formatCount(p.calls)} calls · ${formatCount(p.products)} products${perProduct(p.costPerProductUsd)}`,
              }))}
            />
          ) : (
            <ChartEmpty>No AI calls in {phrase}</ChartEmpty>
          )}
        </ChartFrame>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartFrame
          title="How long a call takes"
          description="Successful answers per model, from sending the question to the full answer"
          table={<DataTable head={["Model", "Average", "Slowest"]} rows={ai.byModel.map((m) => [m.model, formatLatency(m.averageLatencyMs), formatLatency(m.slowestLatencyMs)])} />}
        >
          {ai.byModel.some((m) => m.averageLatencyMs !== null) ? (
            <RangeList
              lowLabel="Average"
              highLabel="Slowest"
              format={formatLatency}
              ranges={ai.byModel
                .filter((m) => m.averageLatencyMs !== null)
                .map((m) => ({
                  key: `${m.provider}:${m.model}`,
                  label: m.model,
                  low: m.averageLatencyMs,
                  high: m.slowestLatencyMs,
                  lowText: formatLatency(m.averageLatencyMs),
                  highText: formatLatency(m.slowestLatencyMs),
                }))}
            />
          ) : (
            <ChartEmpty>No answered calls in {phrase}</ChartEmpty>
          )}
        </ChartFrame>

        <ChartFrame title="Calls that went wrong" description="Each is handled on its own: nothing here needs you to act">
          <ul className="divide-y divide-border">
            {PROBLEMS.map((p) => {
              const count = ai.problems[p.key];
              return (
                <li key={p.key} className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{p.label}</p>
                    <p className="text-xs text-muted-foreground">{p.explain}</p>
                  </div>
                  {count > 0 ? <Badge tone={p.tone}>{formatCount(count)}</Badge> : <span className="pt-0.5 text-sm text-muted-foreground tabular-nums">0</span>}
                </li>
              );
            })}
          </ul>
        </ChartFrame>
      </div>
    </section>
  );
}

function ImportLink({ item }: { item: { id: string; fileName: string } }) {
  return (
    <Link href={`/imports/${item.id}`} className={`${linkClasses} break-all`}>
      {item.fileName}
    </Link>
  );
}

const seconds = (s: number | null) => (s === null ? "–" : formatDuration(s * 1000));

export function ImportsSection({ metrics, days }: { metrics: Metrics; days: PeriodDays }) {
  const { imports } = metrics;
  const byStatus = Object.entries(imports.byStatus)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${formatCount(n)} ${IMPORT_STATUS[status as keyof typeof IMPORT_STATUS].label.toLowerCase()}`);

  return (
    <section aria-labelledby="imports-heading" className="space-y-4">
      <SectionHeading id="imports-heading" title="Imports">
        Uploads started in {periodPhrase(days)}. Time runs from the worker picking a sheet up to its last product, photo and translation.
      </SectionHeading>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Imports" value={formatCount(imports.total)}>
          {byStatus.length ? byStatus.join(", ") : "None yet"}
        </Stat>
        <Stat label="Rows per minute" value={imports.speed.rowsPerMinute === null ? "–" : imports.speed.rowsPerMinute.toLocaleString("en")}>
          All finished imports together
        </Stat>
        <Stat label="Average time per import" value={seconds(imports.speed.averageSeconds)}>
          Finished imports only
        </Stat>
        <Stat label="Slowest import" value={seconds(imports.speed.slowest?.seconds ?? null)}>
          {imports.speed.slowest ? (
            <>
              <ImportLink item={imports.speed.slowest} />, {formatCount(imports.speed.slowest.rows)} rows
            </>
          ) : (
            "No finished imports"
          )}
        </Stat>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <TableCard title="Recent imports" className="xl:col-span-3" empty={imports.recent.length === 0 ? `No imports in ${periodPhrase(days)}` : null}>
          <ImportTable
            imports={imports.recent}
            columns={[
              { head: "File", cell: (i) => <ImportLink item={i} /> },
              { head: "Status", cell: (i) => <Badge tone={IMPORT_STATUS[i.status].tone}>{IMPORT_STATUS[i.status].label}</Badge> },
              { head: "Rows", cell: (i) => formatCount(i.rows), numeric: true },
              { head: "Products", cell: (i) => formatCount(i.products), numeric: true },
              { head: "Time", cell: (i) => seconds(i.seconds), numeric: true },
              { head: "Rows/min", cell: (i) => (i.rowsPerMinute === null ? "–" : i.rowsPerMinute.toLocaleString("en")), numeric: true },
              { head: "AI cost", cell: (i) => formatUsd(i.costUsd), numeric: true },
            ]}
          />
        </TableCard>
        <TableCard title="Cost per import" description="The imports whose AI work cost the most" className="xl:col-span-2" empty={imports.topByCost.length === 0 ? "No AI cost in this period" : null}>
          <ImportTable
            imports={imports.topByCost}
            columns={[
              { head: "File", cell: (i) => <ImportLink item={i} /> },
              { head: "Products", cell: (i) => formatCount(i.products), numeric: true },
              { head: "AI cost", cell: (i) => formatUsd(i.costUsd), numeric: true },
              { head: "Per product", cell: (i) => formatUsd(i.costPerProductUsd), numeric: true },
            ]}
          />
        </TableCard>
      </div>
    </section>
  );
}

function TableCard({ title, description, className = "", empty, children }: { title: string; description?: string; className?: string; empty: string | null; children: ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 ${className}`}>
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {empty ? <ChartEmpty>{empty}</ChartEmpty> : <div className="-mx-4 overflow-x-auto px-4">{children}</div>}
    </div>
  );
}

type ImportColumn = { head: string; cell: (item: ImportStat) => ReactNode; numeric?: boolean };

function ImportTable({ imports, columns }: { imports: ImportStat[]; columns: ImportColumn[] }) {
  return (
    <table className="w-full min-w-max text-left text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr>
          {columns.map((c) => (
            <th key={c.head} scope="col" className={`py-1.5 pr-4 font-medium last:pr-0 ${c.numeric ? "text-right" : ""}`}>
              {c.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {imports.map((item) => (
          <tr key={item.id}>
            {columns.map((c) => (
              <td key={c.head} className={`py-2 pr-4 align-top last:pr-0 ${c.numeric ? "text-right tabular-nums" : "max-w-56"}`}>
                {c.cell(item)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CatalogSection({ metrics }: { metrics: Metrics }) {
  const { catalog } = metrics.products;
  return (
    <section aria-labelledby="catalog-heading" className="space-y-4">
      <SectionHeading id="catalog-heading" title="The catalog now">
        Where every product stands today, whatever import it came from. Only approved products show in the storefront.
      </SectionHeading>
      <div className="rounded-lg border border-border bg-card p-4">
        {catalog.total === 0 ? (
          <ChartEmpty>No products yet. Upload a supplier sheet to start</ChartEmpty>
        ) : (
          <SegmentBar
            label="Products by status"
            segments={[
              { key: "approved", label: "Approved", value: catalog.approved, tone: "success" },
              { key: "ready", label: "Ready to approve", value: catalog.ready, tone: "info" },
              { key: "review", label: "Needs review", value: catalog.needsReview, tone: "warning" },
            ]}
          />
        )}
        {catalog.deleted > 0 && <p className="mt-3 text-xs text-muted-foreground">{formatCount(catalog.deleted)} deleted, not counted above</p>}
      </div>
    </section>
  );
}

const products = (count: number) => `${formatCount(count)} product${count === 1 ? "" : "s"}`;

// What holds back the products waiting for review, the most common kinds of reason first, each with one real reason
// so the merchant sees what it means
export function ReviewReasonsSection({ metrics }: { metrics: Metrics }) {
  const review = metrics.reviewReasons;
  return (
    <section aria-labelledby="review-heading" className="space-y-4">
      <SectionHeading id="review-heading" title="Why products need review">
        The products waiting for you now, from every import: the period above doesn&apos;t change this. Reasons that only differ by row, value or SKU count as one kind, and a product counts once for each kind it has.
      </SectionHeading>
      {review.total === 0 ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <ChartEmpty>Nothing waiting for review</ChartEmpty>
        </div>
      ) : (
        <ChartFrame
          title="Most common reasons"
          description={
            <>
              {products(review.total)} waiting for review{review.kinds > 0 && `, for ${formatCount(review.kinds)} kind${review.kinds === 1 ? "" : "s"} of reason`}.{" "}
              <Link href="/products?status=needs_review" className={linkClasses}>
                Review them
              </Link>
            </>
          }
          table={
            review.top.length > 0 && (
              <DataTable head={["Reason", "Products", "Share of review"]} rows={review.top.map((r) => [r.label, formatCount(r.products), formatPercent(r.share)])} />
            )
          }
        >
          {review.top.length ? (
            <BarList
              bars={review.top.map((r) => ({
                key: r.key,
                label: r.label,
                value: r.products,
                display: formatCount(r.products),
                details: (
                  <>
                    <span className="block">{formatPercent(r.share)} of the products in review</span>
                    <span className="mt-0.5 block break-words">
                      For example: “{r.example.reason}”{" "}
                      <Link href={`/products/${r.example.productId}`} className={linkClasses}>
                        See the product
                      </Link>
                    </span>
                  </>
                ),
              }))}
            />
          ) : (
            <ChartEmpty>Nothing flagged on them any more: they only need approving</ChartEmpty>
          )}
          {review.top.length > 0 && review.withoutReason > 0 && (
            <p className="text-xs text-muted-foreground">Also waiting, with nothing flagged any more and ready to approve: {products(review.withoutReason)}</p>
          )}
        </ChartFrame>
      )}
    </section>
  );
}

export function TranslationsSection({ metrics }: { metrics: Metrics }) {
  const { translations } = metrics;
  return (
    <section aria-labelledby="translations-heading" className="space-y-4">
      <SectionHeading id="translations-heading" title="Translations">
        How much of the catalog shoppers can read in each language. Anything not translated is shown in English, never left blank.
      </SectionHeading>
      <div className="grid gap-4 lg:grid-cols-2">
        {translations.languages.map((language) => {
          const name = LANGUAGE_NAMES[language.locale] ?? language.locale;
          return (
            <div key={language.locale} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{name}</h3>
                  {language.enabled ? <Badge tone="success">Shown to shoppers</Badge> : <Badge tone="neutral">Switched off</Badge>}
                </div>
                <p className="text-2xl font-semibold tracking-tight">{formatPercent(language.coverage)}</p>
              </div>
              {translations.products === 0 ? (
                <ChartEmpty>No products to translate yet</ChartEmpty>
              ) : (
                <SegmentBar label={`${name} translation of the catalog`} segments={translationSegments(language, translations.products)} />
              )}
              <p className="text-xs text-muted-foreground">
                {formatCount(language.merchantFixes)} of your own translation{language.merchantFixes === 1 ? "" : "s"}
                {language.outOfDate > 0 ? (
                  <>
                    , <span className="font-medium text-warning">{formatCount(language.outOfDate)} out of date</span> (the English changed after you wrote them)
                  </>
                ) : (
                  ", none out of date"
                )}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
