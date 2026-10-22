import { sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { aiCalls, importRows, imports, products } from "@/server/db/schema";
import { env } from "@/server/env";
import { translationCoverage } from "@/server/translations/coverage";
import { batchingSavingMicroUsd, cacheSavingMicroUsd, type CallSums, routingSavingMicroUsd } from "./savings";
import { bucketStart, bucketsBetween, type MetricsWindow } from "./window";

// The numbers behind the Metrics tab, for one period: what was processed, how it went, what the AI cost and how
// fast it was, how much our design saved, and how far the catalog is translated. A handful of grouped queries:
// AI calls are summed per hour, model, kind and outcome in the database, never fetched one by one

type CallGroup = {
  // Start of the hour, in milliseconds since 1970 (raw SQL gives timestamps back as text)
  hour_ms: number;
  provider: string;
  model: string;
  purpose: string;
  status: string;
  from_cache: boolean;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  products: number;
  latency_sum: number;
  latency_max: number;
};

type ImportRow = {
  id: string;
  file_name: string;
  status: string;
  created_ms: number;
  started_ms: number | null;
  finished_ms: number | null;
  done: number;
  needs_review: number;
  failed: number;
  pending: number;
  products: number;
  calls: number;
  cost: number;
};

const IMPORT_STATUSES = ["waiting_for_files", "queued", "running", "paused", "done", "failed"] as const;
const RECENT_IMPORTS = 20;
const TOP_IMPORTS = 5;

const usd = (microUsd: number) => Math.round(microUsd) / 1_000_000;
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
const sum = <T>(items: T[], value: (item: T) => number) => items.reduce((total, item) => total + value(item), 0);

// Each provider's cheap and strong model, to price what routing saved
function modelsOf(provider: string) {
  if (provider === "anthropic") return { cheap: env().ANTHROPIC_MODEL_CHEAP, strong: env().ANTHROPIC_MODEL_STRONG };
  if (provider === "deepseek") return { cheap: env().DEEPSEEK_MODEL_CHEAP, strong: env().DEEPSEEK_MODEL_STRONG };
  return { cheap: `${provider}-cheap`, strong: `${provider}-strong` };
}

export async function getMetrics(db: Db, window: MetricsWindow) {
  const { from, to } = window;
  const [callGroups, importList, catalog, translations] = await Promise.all([
    db
      .execute<CallGroup>(sql`
        select (extract(epoch from date_trunc('hour', ${aiCalls.createdAt})) * 1000)::float8 as hour_ms, ${aiCalls.provider} as provider, ${aiCalls.model} as model,
          ${aiCalls.purpose} as purpose, ${aiCalls.status}::text as status, ${aiCalls.fromCache} as from_cache,
          count(*)::int as calls,
          sum(${aiCalls.inputTokens})::float8 as input_tokens,
          sum(${aiCalls.outputTokens})::float8 as output_tokens,
          sum(${aiCalls.costMicroUsd})::float8 as cost,
          sum(${aiCalls.productCount})::float8 as products,
          sum(${aiCalls.latencyMs})::float8 as latency_sum,
          max(${aiCalls.latencyMs})::int as latency_max
        from ${aiCalls}
        where ${aiCalls.createdAt} >= ${from} and ${aiCalls.createdAt} < ${to}
        group by 1, 2, 3, 4, 5, 6
      `)
      .then((r) => r.rows),
    db
      .execute<ImportRow>(sql`
        select i.id, i.sheet_file_name as file_name, i.status::text as status,
          (extract(epoch from i.created_at) * 1000)::float8 as created_ms,
          (extract(epoch from i.started_at) * 1000)::float8 as started_ms,
          (extract(epoch from i.finished_at) * 1000)::float8 as finished_ms,
          r.done, r.needs_review, r.failed, r.pending, r.products, c.calls, c.cost
        from ${imports} i
        cross join lateral (
          select count(*) filter (where status = 'done')::int as done,
            count(*) filter (where status = 'needs_review')::int as needs_review,
            count(*) filter (where status = 'failed')::int as failed,
            count(*) filter (where status in ('pending', 'processing'))::int as pending,
            count(distinct product_key) filter (where status <> 'failed')::int as products
          from ${importRows} where import_id = i.id
        ) r
        cross join lateral (
          select count(*)::int as calls, coalesce(sum(cost_micro_usd), 0)::float8 as cost from ${aiCalls} where import_id = i.id
        ) c
        where i.created_at >= ${from} and i.created_at < ${to}
        order by i.created_at desc
      `)
      .then((r) => r.rows),
    db
      .execute<{ status: string; live: number; deleted: number }>(sql`
        select status::text as status, count(*) filter (where deleted_at is null)::int as live,
          count(*) filter (where deleted_at is not null)::int as deleted
        from ${products} group by status
      `)
      .then((r) => r.rows),
    translationCoverage(db),
  ]);

  return {
    window: { from: from.toISOString(), to: to.toISOString(), bucket: window.bucket },
    ...productAndRowNumbers(importList, catalog),
    imports: importNumbers(importList),
    ai: aiNumbers(callGroups, importList, window),
    savings: await savings(db, callGroups),
    translations: { ...translations, outOfDate: sum(translations.languages, (l) => l.outOfDate) },
  };
}

function productAndRowNumbers(importList: ImportRow[], catalog: { status: string; live: number; deleted: number }[]) {
  const live = (status: string) => catalog.find((c) => c.status === status)?.live ?? 0;
  const total = sum(catalog, (c) => c.live);
  const rows = { done: sum(importList, (i) => i.done), needsReview: sum(importList, (i) => i.needs_review), failed: sum(importList, (i) => i.failed), pending: sum(importList, (i) => i.pending) };
  const rowTotal = rows.done + rows.needsReview + rows.failed + rows.pending;
  return {
    products: {
      // Products the imports of this period wrote (a product imported twice counts twice: it was processed twice)
      processed: sum(importList, (i) => i.products),
      // The catalog as it is now
      catalog: { total, ready: live("ready"), needsReview: live("needs_review"), approved: live("approved"), deleted: sum(catalog, (c) => c.deleted) },
      rates: { ready: percent(live("ready"), total), needsReview: percent(live("needs_review"), total), approved: percent(live("approved"), total) },
    },
    // Rows of the imports of this period: every row ends as done, needs review or failed
    rows: {
      total: rowTotal,
      ...rows,
      rates: { done: percent(rows.done, rowTotal), needsReview: percent(rows.needsReview, rowTotal), failed: percent(rows.failed, rowTotal) },
    },
  };
}

function importNumbers(importList: ImportRow[]) {
  const list = importList.map((i) => {
    const rows = i.done + i.needs_review + i.failed + i.pending;
    // How long a finished import took, from the worker picking it up to its last product (and photo, translation)
    const seconds = i.status === "done" && i.started_ms !== null && i.finished_ms !== null ? Math.round((i.finished_ms - i.started_ms) / 100) / 10 : null;
    return {
      id: i.id,
      fileName: i.file_name,
      status: i.status,
      createdAt: new Date(i.created_ms).toISOString(),
      rows,
      products: i.products,
      seconds,
      rowsPerMinute: seconds ? Math.round((rows / (seconds / 60)) * 10) / 10 : null,
      aiCalls: i.calls,
      costUsd: usd(i.cost),
      costPerProductUsd: i.products ? usd(i.cost / i.products) : null,
    };
  });
  const finished = list.filter((i): i is (typeof list)[number] & { seconds: number } => i.seconds !== null && i.seconds > 0);
  const slowest = finished.reduce<(typeof finished)[number] | null>((worst, i) => (!worst || i.seconds > worst.seconds ? i : worst), null);
  const minutes = sum(finished, (i) => i.seconds) / 60;
  return {
    total: list.length,
    byStatus: Object.fromEntries(IMPORT_STATUSES.map((s) => [s, list.filter((i) => i.status === s).length])) as Record<(typeof IMPORT_STATUSES)[number], number>,
    speed: {
      averageSeconds: finished.length ? Math.round(sum(finished, (i) => i.seconds) / finished.length) : null,
      // All finished imports together: their rows over their time
      rowsPerMinute: minutes ? Math.round((sum(finished, (i) => i.rows) / minutes) * 10) / 10 : null,
      slowest: slowest && { id: slowest.id, fileName: slowest.fileName, rows: slowest.rows, seconds: slowest.seconds },
    },
    recent: list.slice(0, RECENT_IMPORTS),
    topByCost: [...list]
      .filter((i) => i.costUsd > 0)
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, TOP_IMPORTS),
  };
}

function aiNumbers(groups: CallGroup[], importList: ImportRow[], window: MetricsWindow) {
  const billed = groups.filter((g) => !g.from_cache);
  const answered = billed.filter((g) => g.status === "ok");
  const cost = sum(groups, (g) => g.cost);

  const byKey = <K extends string>(keyOf: (g: CallGroup) => K) => {
    const map = new Map<K, CallGroup[]>();
    for (const g of groups) map.set(keyOf(g), [...(map.get(keyOf(g)) ?? []), g]);
    return map;
  };
  const totals = (list: CallGroup[]) => {
    const products = sum(
      list.filter((g) => !g.from_cache),
      (g) => g.products,
    );
    const listCost = sum(list, (g) => g.cost);
    return {
      calls: sum(list, (g) => g.calls),
      // Answered from a saved answer, for free
      cacheHits: sum(
        list.filter((g) => g.from_cache),
        (g) => g.calls,
      ),
      // Products sent to the AI (a batch asked again counts again)
      products,
      inputTokens: sum(list, (g) => g.input_tokens),
      outputTokens: sum(list, (g) => g.output_tokens),
      costUsd: usd(listCost),
      costPerProductUsd: products ? usd(listCost / products) : null,
    };
  };

  const byModel = [...byKey((g) => `${g.provider}|${g.model}`)].map(([key, list]) => {
    const [provider, model] = key.split("|");
    const ok = list.filter((g) => !g.from_cache && g.status === "ok");
    const okCalls = sum(ok, (g) => g.calls);
    return {
      provider,
      model,
      ...totals(list),
      // How long a successful answer took
      averageLatencyMs: okCalls ? Math.round(sum(ok, (g) => g.latency_sum) / okCalls) : null,
      slowestLatencyMs: ok.length ? Math.max(...ok.map((g) => g.latency_max)) : null,
    };
  });

  // The AI cost of this period's imports over the products they wrote (translations and retries included)
  const importProducts = sum(importList, (i) => i.products);
  const importCost = sum(importList, (i) => i.cost);

  const buckets = new Map(bucketsBetween(window).map((at) => [at.getTime(), { at: at.toISOString(), calls: 0, costMicroUsd: 0, inputTokens: 0, outputTokens: 0 }]));
  for (const g of groups) {
    const bucket = buckets.get(bucketStart(new Date(g.hour_ms), window.bucket).getTime());
    if (!bucket) continue;
    bucket.calls += g.calls;
    bucket.costMicroUsd += g.cost;
    bucket.inputTokens += g.input_tokens;
    bucket.outputTokens += g.output_tokens;
  }

  const failed = (status: string) => sum(
    billed.filter((g) => g.status === status),
    (g) => g.calls,
  );
  return {
    ...totals(groups),
    costUsd: usd(cost),
    costPerProductUsd: importProducts ? usd(importCost / importProducts) : null,
    costPer1000ProductsUsd: importProducts ? Math.round((importCost / importProducts) * 1000) / 1_000_000 : null,
    answeredCalls: sum(answered, (g) => g.calls),
    byModel: byModel.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
    byPurpose: [...byKey((g) => g.purpose)].map(([purpose, list]) => ({ purpose, ...totals(list) })),
    // Calls that went wrong. Rate limits and timeouts are tried again; invalid answers are asked again
    problems: { rateLimited: failed("rate_limited"), timeout: failed("timeout"), invalidOutput: failed("invalid_output"), error: failed("error") },
    overTime: [...buckets.values()].map(({ costMicroUsd, ...b }) => ({ ...b, costUsd: usd(costMicroUsd) })),
  };
}

const NOTES = {
  cache: "Calls answered from saved answers (a retry after a crash, the same question again) cost nothing; each is priced like a real call of the same model and kind, per product.",
  routing: "Calls that went to the cheap model, priced at the strong model's rates with the same tokens, the same share of cached input and the same time of day, minus what they cost.",
  batching: "Up to 10 products share one call, so the instructions are sent once per batch instead of once per product; the extra instructions, priced like our real calls' input (including the share the AI provider bills at its cheaper cached rate).",
};

async function savings(db: Db, groups: CallGroup[]) {
  const billed = groups.filter((g) => !g.from_cache && (g.status === "ok" || g.status === "invalid_output"));

  // Calls that sent a batch and were billed, summed per hour, model and kind
  const sums = new Map<string, CallSums & { provider: string; purpose: string }>();
  for (const g of billed) {
    const key = `${g.hour_ms}|${g.provider}|${g.model}|${g.purpose}`;
    const s = sums.get(key) ?? { hour: new Date(g.hour_ms), provider: g.provider, model: g.model, purpose: g.purpose, calls: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0, products: 0 };
    s.calls += g.calls;
    s.inputTokens += g.input_tokens;
    s.outputTokens += g.output_tokens;
    s.costMicroUsd += g.cost;
    s.products += g.products;
    sums.set(key, s);
  }
  let routing = 0;
  let routedCalls = 0;
  let batching = 0;
  let extraTokens = 0;
  for (const s of sums.values()) {
    const { cheap, strong } = modelsOf(s.provider);
    if (s.model === cheap && cheap !== strong) {
      routing += routingSavingMicroUsd(s, strong);
      routedCalls += s.calls;
    }
    const b = batchingSavingMicroUsd(s, s.purpose);
    batching += b.microUsd;
    extraTokens += b.extraTokens;
  }

  // What a product costs per model and kind, from the period's answered calls (or all time, if the period has none)
  const kindOf = (g: { model: string; purpose: string }) => `${g.model}|${g.purpose}`;
  const reference = new Map<string, { costMicroUsd: number; products: number }>();
  for (const g of groups.filter((g) => !g.from_cache && g.status === "ok" && g.products > 0)) {
    const r = reference.get(kindOf(g)) ?? { costMicroUsd: 0, products: 0 };
    r.costMicroUsd += g.cost;
    r.products += g.products;
    reference.set(kindOf(g), r);
  }
  const hits = groups.filter((g) => g.from_cache);
  if (hits.some((g) => !reference.has(kindOf(g)))) {
    const { rows } = await db.execute<{ model: string; purpose: string; cost: number; products: number }>(sql`
      select ${aiCalls.model} as model, ${aiCalls.purpose} as purpose, sum(${aiCalls.costMicroUsd})::float8 as cost,
        sum(${aiCalls.productCount})::float8 as products
      from ${aiCalls} where not ${aiCalls.fromCache} and ${aiCalls.status} = 'ok' and ${aiCalls.productCount} > 0
      group by 1, 2
    `);
    for (const r of rows) if (!reference.has(kindOf(r))) reference.set(kindOf(r), { costMicroUsd: r.cost, products: r.products });
  }
  const cache = sum(hits, (g) => cacheSavingMicroUsd(g.products, reference.get(kindOf(g))));

  return {
    totalUsd: usd(cache + routing + batching),
    cache: { usd: usd(cache), calls: sum(hits, (g) => g.calls), note: NOTES.cache },
    routing: { usd: usd(routing), calls: routedCalls, note: NOTES.routing },
    batching: { usd: usd(batching), extraInstructionTokens: extraTokens, note: NOTES.batching },
  };
}
