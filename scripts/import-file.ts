// Uploads a sheet through the API, waits for the worker, then prints what happened to every row.
// Needs `pnpm dev` and `pnpm worker` running.
//   pnpm import:file samples/catalogforge_test_sheet.csv [--currency GBP] [--url http://localhost:3000]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    currency: { type: "string", default: "EUR" },
    url: { type: "string", default: "http://localhost:3000" },
  },
});

const file = positionals[0];
if (!file) {
  console.error("Usage: pnpm import:file <path to csv/xlsx> [--currency EUR] [--url http://localhost:3000]");
  process.exit(1);
}

type Summary = {
  status: string;
  stage: string | null;
  error: string | null;
  totalRows: number | null;
  rows: Record<string, number>;
  rowsWithReviewIssues: number;
  products: number;
  parseInfo: {
    columns: Record<string, string>;
    unmappedColumns: string[];
    blankRows: number;
    headerRow: number;
    format: string;
    optionColumns: { name: string; value: string }[];
    ignoredRows: { rowNumber: number; text: string }[];
  } | null;
};

type Row = {
  rowNumber: number;
  status: string;
  reason: string | null;
  productKey: string | null;
  cleaned: {
    sku: string | null;
    title: string | null;
    priceCents: number | null;
    currency: string | null;
    size: string | null;
    weightGrams: number | null;
    color: string | null;
    role: string;
    options: Record<string, string>;
    issues: { severity: string; message: string }[];
  } | null;
};

async function main() {
  const base = values.url!;
  const form = new FormData();
  form.set("sheet", new Blob([await readFile(file)]), path.basename(file));
  form.set("defaultCurrency", values.currency!);

  const started = Date.now();
  const res = await fetch(`${base}/api/imports`, { method: "POST", body: form });
  const created = (await res.json()) as { id?: string; error?: string; alreadyRunning?: boolean };
  if (!res.ok || !created.id) throw new Error(`Upload refused (${res.status}): ${created.error}`);
  console.log(`uploaded in ${Date.now() - started} ms -> import ${created.id}${created.alreadyRunning ? " (already running)" : ""}`);

  // Step 3 (AI) isn't built yet, so the import stops at the "build" stage
  let summary: Summary;
  for (;;) {
    summary = (await (await fetch(`${base}/api/imports/${created.id}`)).json()) as Summary;
    if (summary.status === "failed" || summary.status === "done" || summary.stage === "build") break;
    if (Date.now() - started > 60_000) throw new Error(`Still ${summary.status}/${summary.stage} after 60s. Is the worker running?`);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`processed in ${Date.now() - started} ms: status=${summary.status} stage=${summary.stage}`);
  if (summary.error) {
    console.log(`error: ${summary.error}`);
    return;
  }
  console.log(
    `rows=${summary.totalRows} (blank rows skipped: ${summary.parseInfo?.blankRows}) products=${summary.products} ` +
      `failed=${summary.rows.failed} with review issues=${summary.rowsWithReviewIssues}`,
  );
  const info = summary.parseInfo;
  console.log(`format: ${info?.format}, header on row ${info?.headerRow}`);
  console.log(`columns: ${JSON.stringify(info?.columns)}`);
  if (info?.optionColumns.length) console.log(`option columns: ${info.optionColumns.map((o) => `${o.name} / ${o.value}`).join(", ")}`);
  if (info?.unmappedColumns.length) console.log(`kept as extra text: ${info.unmappedColumns.join(", ")}`);
  for (const ignored of info?.ignoredRows ?? []) console.log(`ignored row ${ignored.rowNumber} (not a product): "${ignored.text}"`);

  const { rows } = (await (await fetch(`${base}/api/imports/${created.id}/rows?limit=100`)).json()) as { rows: Row[] };
  for (const row of rows) {
    const c = row.cleaned;
    const price = c?.priceCents != null ? `${(c.priceCents / 100).toFixed(2)} ${c.currency}` : "no price";
    const role = c && c.role !== "variant" ? ` [${c.role} row]` : "";
    const options = c && Object.keys(c.options).length ? ` | ${Object.entries(c.options).map(([k, v]) => `${k}: ${v}`).join(", ")}` : "";
    console.log(
      `\nrow ${row.rowNumber}  ${row.status.toUpperCase()}${role}  ${row.productKey ?? "-"}  ${c?.sku ?? "-"}  ${c?.title ?? "(no name)"}  | ${price} | ${c?.size ?? "-"} | ${c?.weightGrams ?? "-"} g | ${c?.color ?? "-"}${options}`,
    );
    for (const issue of c?.issues ?? []) console.log(`   ${issue.severity === "review" ? "REVIEW" : "info  "}  ${issue.message}`);
    if (row.status === "failed") console.log(`   FAILED  ${row.reason}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
