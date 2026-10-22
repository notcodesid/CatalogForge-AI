// Uploads a sheet through the API, waits until the import is done, then prints the products it made.
// Needs `pnpm dev` and `pnpm worker` running.
//   pnpm import:file samples/catalogforge_test_sheet.csv [--photos <folder or zip>]... [--currency GBP] [--url http://localhost:3000] [--rows]
// With --photos, it uploads like the dashboard will: the sheet first (waiting for files), the photos in batches,
// then starts the import
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    currency: { type: "string", default: "EUR" },
    url: { type: "string", default: "http://localhost:3000" },
    rows: { type: "boolean", default: false },
    timeout: { type: "string", default: "300" },
    photos: { type: "string", multiple: true, default: [] },
  },
});

const file = positionals[0];
if (!file) {
  console.error("Usage: pnpm import:file <path to csv/xlsx> [--photos <folder or zip>]... [--currency EUR] [--url http://localhost:3000] [--rows]");
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
  productsByStatus: Record<string, number>;
  photos: Record<string, number> & { missing: { file: string; rows: number[] }[] };
  translations: Record<string, Record<string, number>>;
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

type Product = {
  status: string;
  title: string;
  handle: string;
  category: string | null;
  tags: string[];
  attributes: Record<string, string>;
  claims: { text: string; source: string; quote: string }[];
  reviewReason: string | null;
  sourceRows: number[];
  model: string | null;
  variants: { sku: string; options: Record<string, string>; priceCents: number | null; currency: string | null }[];
  photos: { fileName: string; sku: string | null; width: number; height: number }[];
};

type Photo = { fileName: string; status: string; reason: string | null; productTitle: string | null };

type Translations = {
  languages: {
    locale: string;
    enabled: boolean;
    status: string | null;
    error: string | null;
    fields: Record<string, { issue: string | null }>;
    shown: { title: string; descriptionHtml: string; sources: Record<string, string> };
  }[];
};

type ProductWithId = Product & { id: string };

// The files to send: everything in a folder, or the file itself (a photo or a ZIP)
async function photoFiles(paths: string[]) {
  const files: string[] = [];
  for (const p of paths) {
    if ((await stat(p)).isDirectory()) files.push(...(await readdir(p)).sort().map((name) => path.join(p, name)));
    else files.push(p);
  }
  return files;
}

async function postForm(url: string, form: FormData) {
  const res = await fetch(url, { method: "POST", body: form });
  const body = (await res.json()) as Record<string, unknown> & { error?: string };
  if (!res.ok) throw new Error(`Refused (${res.status}): ${body.error}`);
  return body;
}

// A dropped connection while polling shouldn't end the test run: try the request again a few times
async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

const money = (cents: number | null, currency: string | null) => (cents === null ? "no price" : `${(cents / 100).toFixed(2)} ${currency}`);

async function main() {
  const base = values.url!;
  const form = new FormData();
  form.set("sheet", new Blob([await readFile(file)]), path.basename(file));
  form.set("defaultCurrency", values.currency!);

  const files = await photoFiles(values.photos!);
  if (files.length) form.set("waitForPhotos", "true");

  const started = Date.now();
  const res = await fetch(`${base}/api/imports`, { method: "POST", body: form });
  const created = (await res.json()) as { id?: string; error?: string; alreadyRunning?: boolean };
  if (!res.ok || !created.id) throw new Error(`Upload refused (${res.status}): ${created.error}`);
  console.log(`uploaded in ${Date.now() - started} ms -> import ${created.id}${created.alreadyRunning ? " (already running)" : ""}`);

  if (files.length) {
    // 20 files per request, like a browser uploading a big folder
    for (let i = 0; i < files.length; i += 20) {
      const batch = new FormData();
      for (const f of files.slice(i, i + 20)) batch.append("photos", new Blob([await readFile(f)]), path.basename(f));
      const added = await postForm(`${base}/api/imports/${created.id}/photos`, batch);
      console.log(`photos: sent ${Math.min(i + 20, files.length)}/${files.length} files -> ${JSON.stringify(added)}`);
    }
    await postForm(`${base}/api/imports/${created.id}/start`, new FormData());
    console.log(`started after ${Date.now() - started} ms`);
  }

  let summary: Summary;
  const timeoutMs = Number(values.timeout) * 1000;
  for (;;) {
    summary = await getJson<Summary>(`${base}/api/imports/${created.id}`);
    if (summary.status === "failed" || summary.status === "done") break;
    if (Date.now() - started > timeoutMs) throw new Error(`Still ${summary.status}/${summary.stage} after ${values.timeout}s. Is the worker running?`);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`processed in ${Date.now() - started} ms: status=${summary.status}`);
  if (summary.error) {
    console.log(`error: ${summary.error}`);
    return;
  }

  const r = summary.rows;
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  console.log(
    `rows=${summary.totalRows}: done=${r.done} needs_review=${r.needs_review} failed=${r.failed} (pending=${r.pending}) -> adds up: ${total === summary.totalRows}`,
  );
  console.log(`products=${summary.products}: ${JSON.stringify(summary.productsByStatus)}`);
  console.log(`translations: ${JSON.stringify(summary.translations)}`);
  const { missing, ...photoCounts } = summary.photos;
  if (photoCounts.total) {
    console.log(`photos: ${JSON.stringify(photoCounts)}`);
    for (const m of missing) console.log(`   the sheet names ${m.file} (row ${m.rows.join(", ")}) but it wasn't uploaded`);
    const { photos } = await getJson<{ photos: Photo[] }>(`${base}/api/imports/${created.id}/photos?limit=200`);
    for (const ph of photos) {
      const where = ph.status === "matched" ? `-> ${ph.productTitle ?? "(product not saved)"}` : "";
      console.log(`   ${ph.status.toUpperCase().padEnd(9)} ${ph.fileName} ${where}  (${ph.reason})`);
    }
  }
  const info = summary.parseInfo;
  console.log(`format: ${info?.format}, header on row ${info?.headerRow}, blank rows skipped: ${info?.blankRows}`);
  console.log(`columns: ${JSON.stringify(info?.columns)}`);
  if (info?.optionColumns.length) console.log(`option columns: ${info.optionColumns.map((o) => `${o.name} / ${o.value}`).join(", ")}`);
  if (info?.unmappedColumns.length) console.log(`kept as extra text: ${info.unmappedColumns.join(", ")}`);
  for (const ignored of info?.ignoredRows ?? []) console.log(`ignored row ${ignored.rowNumber} (not a product): "${ignored.text}"`);

  const { products } = await getJson<{ products: ProductWithId[] }>(`${base}/api/imports/${created.id}/products?limit=100`);
  for (const p of products) {
    console.log(`\n${p.status === "ready" ? "READY " : "REVIEW"}  ${p.title}  (/${p.handle}, rows ${p.sourceRows.join(", ")}, ${p.model})`);
    console.log(`        category: ${p.category ?? "-"} | tags: ${p.tags.join(", ")}`);
    if (Object.keys(p.attributes).length) console.log(`        attributes: ${Object.entries(p.attributes).map(([k, v]) => `${k}: ${v}`).join(" | ")}`);
    for (const v of p.variants) {
      const options = Object.values(v.options).join(", ");
      console.log(`        variant ${v.sku}${options ? ` (${options})` : ""}: ${money(v.priceCents, v.currency)}`);
    }
    for (const c of p.claims) console.log(`        claim "${c.text}" <- ${c.source}: "${c.quote}"`);
    if (p.photos.length) console.log(`        photos: ${p.photos.map((ph) => `${ph.fileName}${ph.sku ? ` (${ph.sku})` : ""} ${ph.width}x${ph.height}`).join(", ")}`);
    if (p.reviewReason) for (const reason of p.reviewReason.split("; ")) console.log(`        why review: ${reason}`);
    const { languages } = await getJson<Translations>(`${base}/api/products/${p.id}/translations`);
    for (const lang of languages.filter((l) => l.enabled)) {
      const text = lang.shown.descriptionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      console.log(`        ${lang.locale}: ${lang.shown.title} | ${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`);
      for (const [field, f] of Object.entries(lang.fields)) if (f.issue) console.log(`        ${lang.locale} ${field} shown in English: ${f.issue}`);
      if (lang.error) console.log(`        ${lang.locale} failed: ${lang.error}`);
    }
  }

  if (!values.rows) return;
  const { rows } = await getJson<{ rows: Row[] }>(`${base}/api/imports/${created.id}/rows?limit=100`);
  for (const row of rows) {
    const c = row.cleaned;
    const role = c && c.role !== "variant" ? ` [${c.role} row]` : "";
    console.log(`\nrow ${row.rowNumber}  ${row.status.toUpperCase()}${role}  ${row.productKey ?? "-"}  ${c?.sku ?? "-"}  ${c?.title ?? "(no name)"}  | ${money(c?.priceCents ?? null, c?.currency ?? null)}`);
    for (const issue of c?.issues ?? []) console.log(`   ${issue.severity === "review" ? "REVIEW" : "info  "}  ${issue.message}`);
    if (row.status === "failed") console.log(`   FAILED  ${row.reason}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
