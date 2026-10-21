# CatalogForge

Turns a messy supplier spreadsheet and product photos into a clean, translated product catalog.

Work in progress. See [EDGE-CASES.md](EDGE-CASES.md) for what can go wrong and how the app handles it.

## Run it locally

Needs Node 22.12+, pnpm and Docker.

```bash
pnpm install
cp .env.example .env.local
pnpm db:up          # Postgres in Docker, on port 5433
pnpm db:migrate     # create the tables
```

Then, in two terminals:

```bash
pnpm dev            # API + web app on http://localhost:3000
pnpm worker         # background worker that processes the queue
```

Check everything is connected:

```bash
curl http://localhost:3000/api/health   # database, queue, and how many workers are online
pnpm queue:ping                         # sends a test job and waits for the worker to finish it
```

Import a sheet (with `pnpm dev` and `pnpm worker` running):

```bash
pnpm import:file samples/catalogforge_test_sheet.csv    # uploads it, waits, prints what happened to every row
```

## API so far

| Route | What it does |
|---|---|
| `POST /api/imports` | Upload a sheet (multipart field `sheet`, optional `defaultCurrency`). Returns right away with the import id |
| `GET /api/imports/:id` | Status, stage and row counts (pending / done / needs review / failed) |
| `GET /api/imports/:id/rows?status=&limit=&offset=` | Each row: what the sheet said, the cleaned values, and why it needs review or failed |
| `GET /api/health` | Database, queue, and how many workers are online |

## Scripts

| Script | What it does |
|---|---|
| `pnpm db:up` / `pnpm db:down` | Start / stop Postgres in Docker |
| `pnpm db:generate` | Create a migration after changing `src/server/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:studio` | Browse the database in the browser |
| `pnpm worker` | Run the background worker (`worker:dev` restarts on file changes) |
| `pnpm import:file <file>` | Upload a sheet through the API and print the result for every row |
| `pnpm test` | Run tests against a separate test database |
| `pnpm typecheck` / `pnpm lint` | Type check / lint |

## Layout

```
src/
  app/api/          API routes
  server/
    db/             tables (schema.ts) and the database connection
    queue/          pg-boss setup and the list of queues
    pipeline/       reading sheets (read-sheet.ts), cleaning rows (clean/), grouping rows into products (group.ts),
                    and the background job that runs them (run-parse-import.ts)
    imports/        creating an import, reading its status, and the watchdog that restarts stuck imports
    storage/        where uploaded files are saved (a local folder for now)
  worker/           the background worker
scripts/            terminal scripts for testing
samples/            test sheets: messy supplier sheets, Shopify and WooCommerce exports, German and French files,
                    a messy Excel layout, broken files, and a 5,000-row sheet (samples/test-files)
drizzle/            SQL migrations
docker/             Postgres init (creates the test database)
```
