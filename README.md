# CatalogForge

Turns a messy supplier spreadsheet and product photos into a clean product catalog in English, German and French,
with a review screen for the merchant, a storefront and exports.

(Screenshots of the upload, review, metrics and shop pages go here.)

## What it does

1. **Upload** a CSV or XLSX sheet (up to 10,000 rows) and photos (files, folders or a ZIP). The upload returns at
   once and a background worker does the rest.
2. **Clean** in code: prices to cents, units, typos, broken text and HTML, rows grouped into products and variants,
   photos matched to products by name.
3. **Write** each listing with Claude: title, description, category, tags, attributes and claims. Every claim
   quotes the supplier's words, code checks every answer, and anything unclear goes to review.
4. **Translate** into German and French ahead of time, checked in code the same way.
5. **Review** in the dashboard. The **storefront** shows approved products in the visitor's language. Export as
   CSV, JSON or Shopify CSV.

## Quick start

Needs Node 22.12+, pnpm and Docker.

```bash
pnpm install
cp .env.example .env.local   # starts with the free offline mock AI. For Claude: AI_PROVIDER=anthropic and ANTHROPIC_API_KEY
pnpm db:up                   # Postgres in Docker, on port 5433
pnpm db:migrate
pnpm dev                     # http://localhost:3000
pnpm worker                  # in a second terminal
```

All the settings and scripts are in [Setup](docs/setup.md).

## Measured with real Claude

| | Result |
|---|---|
| 10,000-row sheet | 6,302 products written and translated into German and French in 20 min 22 s, 0 rows failed |
| Cost | $0.37 per 1,000 products, writing and translating included |
| Worker killed with `kill -9` at 32% of a 5,000-row import | Picked up again within about 30 s: 0 duplicates, nothing lost |
| Storefront during the 10,000-row import | 99% of requests under 308 ms (shop page) and 505 ms (product page), 0 errors |
| A 10,001-row sheet | Refused in about 1 s, before any AI call |

How these were measured, and what breaks first at 1,000,000 products: [Technical write-up](docs/write-up.md).

## How it works, in short

- **Architecture:** a Next.js app (dashboard, storefront and API) and a Node worker share one Postgres database,
  which also holds the job queue (pg-boss). Only the worker calls the AI, and the storefront only reads Postgres.
  [More](docs/architecture.md)
- **Scale and reliability:** a job is queued in the same transaction as the work it stands for, and every step can
  safely run twice. A dead worker's jobs are picked up again, and AI errors are retried. A rate limit pauses every
  worker, and they carry on by themselves. Every row ends as Done, Needs review or Failed. [More](docs/scale-and-reliability.md)
- **Cost:** clean products go to Haiku and messy ones to Sonnet, 10 products per call. Saved AI answers are reused,
  and rows that didn't change skip the AI on a re-upload. [More](docs/cost.md)
- **Accuracy:** code does the facts (prices, units, variants). Every claim must quote the supplier, and a claim that
  is denied, partial or stronger than the source is removed and sent to review. [More](docs/accuracy.md)
- **Tech stack:** Next.js 16, Postgres 17 with Drizzle, pg-boss 12, a Node worker, zod, sharp, SheetJS, Tailwind
  and Vitest. [Design decisions and their trade-offs](docs/tech-stack.md)

## Documentation

| Page | What's in it |
|---|---|
| [Setup](docs/setup.md) | Running it locally, AI providers, speed settings, every script (including the demo workers and the reset) |
| [Using the app](docs/using-the-app.md) | A tour of Upload, Products, Metrics, Languages and the storefront |
| [Architecture](docs/architecture.md) | The diagram, the background jobs, how an import works step by step, the code layout |
| [Scale and reliability](docs/scale-and-reliability.md) | The queue, retries, restarts, duplicate protection, and the crash test |
| [Cost](docs/cost.md) | Model routing, batching, caching, and the measured cost |
| [Accuracy](docs/accuracy.md) | How invented claims are stopped, and why products go to review |
| [Tech stack and design decisions](docs/tech-stack.md) | What we picked and what each choice costs |
| [API](docs/api.md) | Every API route |
| [Technical write-up](docs/write-up.md) | Measured numbers, and what breaks first at 1,000,000 products in 8 languages |
| [EDGE-CASES.md](EDGE-CASES.md) | Everything that can go wrong, and how the app handles it |
