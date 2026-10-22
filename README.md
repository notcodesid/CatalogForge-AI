# CatalogForge

Turns a messy supplier spreadsheet and product photos into a clean, translated product catalog.

Work in progress. See [EDGE-CASES.md](EDGE-CASES.md) for what can go wrong and how the app handles it.

## Architecture

```
 Browser: dashboard (upload, review, metrics) and storefront
    |  upload returns at once with an import id
    v
 Next.js: API routes and pages  ----reads/writes---->  Postgres  <----reads/writes----  Worker (Node)
                                                         |                                 |
                                       data: imports, rows, products,              only the worker calls
                                       variants, photos, translations,             the AI (DeepSeek)
                                       AI calls and cache
                                       queue: pg-boss jobs, in the same database
```

One database holds the data and the job queue (pg-boss). A job is queued in the same transaction that records
why it's needed, so work is never lost and never queued twice. The worker runs the jobs:

1. `parse-import`: read the file, clean every row, group rows into products, match photos, plan the AI batches
2. `build-batch`: 10 products per AI call, checked in code, saved
3. `translate-batch`: 10 products per call, one language at a time, checked in code, saved
4. `process-photos`: 50 photos per job, resized, in parallel with the rest
5. `watchdog`: every minute, restarts anything whose job went missing

The storefront only reads Postgres. It never calls the AI and never waits for an import.

## Scale and reliability

- **The upload returns at once.** All the work runs in the queue, in batches.
- **Every step can run twice without harm.** Rows are unique per import and row number, products are updated by
  their key or SKU, variants by SKU, photos by import and file name, translations by product, language and field.
  An AI answer is saved under a hash of its question, so a batch that runs again after a crash pays nothing.
- **A restart loses nothing.** The import remembers its stage. A worker that dies stops sending heartbeats and its
  job goes to another worker. A worker that only froze can't overwrite newer work: every save checks it still holds
  the import's newest attempt number. The watchdog restarts imports, AI batches, photos and translations whose job
  went missing, and after 3 restarts fails the import with a clear message instead of spinning forever.
- **No duplicates.** The same file can't be imported twice at the same time (a unique index, so even two uploads
  in the same millisecond end up as one). The same products from a differently laid out file are matched by SKU.
  Web addresses (handles) are given out under a lock.
- **AI failures and limits.** Errors and timeouts are retried with growing waits. Broken JSON is asked again with
  the error explained, then on the stronger model. A cut-off answer is split in half. "Too many requests" pauses
  every worker at once and the import shows "Paused" with the time it resumes. An empty account pauses too, and
  carries on by itself after a top-up. A batch that fails every try marks its rows Failed with the reason.
- **Every row ends as Done, Needs review or Failed**, and the counts always add up to the sheet. They're counted
  from the rows themselves, never kept as +1 counters that a retry could get wrong.

## Cost

- **Routing:** clean products go to the cheap model, messy ones (other languages, conflicts, missing names) to the
  stronger one. Translations use the cheap model and only ask the stronger one when our checks find a problem.
- **Batching:** 10 products per call, so the instructions are paid once per batch, not per product. DeepSeek also
  bills instructions it has seen before at about 2% of the price.
- **Never paying twice:** our own cache of AI answers; unchanged rows on a re-upload skip the AI; a price list
  that brings no new product text only updates prices; only the translation fields whose English changed are
  translated again; languages no country uses aren't translated at all.
- **No AI where code does it:** prices, units, variants, grouping, photo matching, category names in German and
  French, SEO fields.
- **Tracked:** every call's tokens, time and cost per model, product and import (`ai_calls`).

Measured with real DeepSeek on 1,000 rows: $0.26 per 1,000 products off-peak, all in ($0.09 to write them, $0.17 to
translate them into German and French); at peak prices it's double. The Metrics tab shows the live figures,
and what routing, batching and the answer cache saved.

## Accuracy: how invented claims are stopped

- **Code, not the AI, does the facts.** Prices become integer cents with a currency, sizes and weights become cm
  and grams, colours are matched against a list, rows are grouped into products and variants. The AI never sets a
  price, SKU, size or weight.
- **Every claim must quote the supplier.** The AI gives the row, column and exact words for each claim. Code checks
  the words are really there, and that they don't deny the claim ("not frost-proof", "nicht frostfest"), using a
  list of risky claims in English, German and French. A claim that fails is removed and the product goes to review.
- **Invented details are caught too.** A description sentence with two or more words the supplier never used goes
  to review, with the sentence shown ("for marking plants in beds, pots and seed trays").
- **Unclear means review, not a guess:** low confidence, conflicting rows, a missing price, a category outside the
  fixed list, text that looks like instructions to the AI (removed before the AI sees it).
- **Translations are checked the same way:** a translation can't make a claim stronger or drop a "not", and every
  number, unit, code and HTML tag must survive.
- **Tested on real messy files** with the real AI, fixing what they showed (see the commit history).

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
pnpm import:file samples/catalogforge_test_sheet.csv --photos samples/test-files/09-photos/photos   # with photos
pnpm import:file samples/test-files/09-photos/photo_links.csv    # photos from links: real ones, broken ones, unsafe ones
```

## Using the app

- **Upload** (`/`): drop a CSV or XLSX sheet plus photos (files, folders or a ZIP). Each import shows live progress
  (rows done / needs review / failed, photos, translations per language, "Paused — resuming at ..."), its rows with
  the reason for each, its photo report, and "Try failed ones again".
- **Products** (`/products`): the catalog with search, filters, sortable columns, 10/25/50/100 per page and
  colour-coded confidence. Bulk approve and export (CSV, JSON, Shopify). A product's review screen shows the
  supplier's rows and photos next to what the AI wrote, with every claim's source, and lets you edit, approve, send
  back, fix translations and assign photos.
- **Metrics** (`/metrics`): success, review and failure rates, cost per 1,000 products, cost over time, model use,
  speed, problems, translation coverage, money saved by routing, batching and the answer cache.
- **Languages** (`/languages`): switch countries on or off (Germany, Austria, Switzerland, Liechtenstein -> German;
  France, Belgium, Luxembourg, Monaco -> French). Switching on a language no country showed yet translates the
  catalog into it in the background. Shows coverage per language and lets you retry failed translations.
- **Storefront** (`/shop`): approved products only, in the visitor's language by country (Germany and Austria get
  German, France gets French, everyone else English; a switcher in the header, or `?country=DE`). Pages are read
  from a short cache, never from the AI, and update the moment a product is approved or changed.
- **Demo mode:** set `AI_PROVIDER=mock` to run everything offline and free.

## API

Dashboard at `/` (Upload, Products, Metrics), storefront at `/shop`.

| Route | What it does |
|---|---|
| `GET /api/imports?limit=&offset=` | The upload queue, newest first, with each import's live counts |
| `GET /api/imports/:id/events` | Live progress (Server-Sent Events): the import's summary whenever it changes, then `end` |
| `POST /api/imports/:id/retry` | Rows the AI failed on, and failed translations, get another try. An unreadable file can't: upload it again |
| `POST /api/imports` | Upload a sheet (multipart field `sheet`), optionally with `photos` (photos or ZIPs), `waitForPhotos=true` and `defaultCurrency`. Returns right away with the import id |
| `POST /api/imports/:id/photos` | More photos (field `photos`) for an import that waits for its files. Big photo sets go in several requests; sending a file twice does nothing |
| `POST /api/imports/:id/start` | Starts an import that waited for its photos |
| `GET /api/imports/:id` | Status, what's happening now (phase), row counts, photo counts, and translation progress per language |
| `GET /api/imports/:id/rows?status=&limit=&offset=` | Each row: what the sheet said, the cleaned values, and why it needs review or failed |
| `GET /api/imports/:id/products?limit=&offset=` | The products the import wrote: title, category, claims with their sources, confidence, variants, photos, why it needs review |
| `GET /api/imports/:id/photos?status=&limit=&offset=` | Each photo: which product it went to and how, or why it's unmatched or rejected |
| `GET /api/photos/:id?size=thumb` | A processed photo (WebP, at most 1600 px) or its 400 px thumbnail |
| `PATCH /api/photos/:id` | Put a photo on a product by hand: `{ "sku": "TC-PL-30" }` (that variant's product), `{ "productId": "..." }`, or `{ "productId": null }` to take it off. Matching never undoes it |
| `GET /api/products?page=&pageSize=&sort=&order=&search=&status=&category=&importId=&maxConfidence=&deleted=` | The catalog for the Products tab: 10/25/50/100 per page, sortable, search by title, handle or SKU |
| `GET /api/products/:id` | Everything for the review screen: the AI's fields with confidence, claims with sources, variants, photos, the supplier's rows next to them, translation state |
| `PATCH /api/products/:id` | The merchant edits the English (title, description, category, tags, attributes). Edited fields are never overwritten by a re-upload; only changed fields are translated again |
| `POST /api/products/:id/approve` | Shows it in the storefront. Refused while a variant has no price |
| `POST /api/products/:id/send-back` | `{ "reason": "..." }`: back to Needs review with the merchant's reason |
| `POST /api/products/bulk-approve` | `{ "ids": [...] }` or `{ "importId": "..." }` (its ready products). Says which were skipped and why |
| `DELETE /api/products/:id` / `POST /api/products/:id/restore` | Soft delete (gone from the storefront and exports, kept so a re-upload doesn't bring it back) / restore |
| `GET /api/export?format=csv\|json\|shopify&status=approved\|ready\|all&language=en\|de\|fr` | Download the catalog: CSV (a row per variant), JSON (the brief's format plus photos and translations) or Shopify's product CSV. Streams 200 products at a time |
| `GET /api/metrics?days=` | The Metrics tab: rates, imports and speed, AI calls and cost by model and purpose, cost over time, problems, translation coverage, money saved (estimates, each with its method) |
| `GET /api/products/:id/translations` | The English, and per language: each field's translation (by the AI or the merchant, its problem, out of date or not) and what shoppers see |
| `PUT /api/products/:id/translations/:locale/:field` | `{ "value": ... }`: the merchant's own translation (always wins; checks come back as warnings). `{ "confirm": true }`: still right after the English changed |
| `DELETE /api/products/:id/translations/:locale/:field` | Drop the merchant's translation; the AI translates the field again |
| `GET /api/translations` | Translation coverage per language, failures, fields shown in English, merchant translations out of date |
| `POST /api/translations/retry` | Try failed translations again (all, or `{ "productIds": [...] }`) |
| `GET /api/settings/languages` | Which language each country sees |
| `PUT /api/settings/languages/:country` | `{ "enabled": true }`: switch a country's language on (the catalog gets translated into it) or off |
| `GET /api/health` | Database, queue, and how many workers are online |

## How an import works

1. **Upload** saves the sheet and the photos and queues the work. The request returns straight away. Up to 2,000
   photos per import (JPEG, PNG or WebP, 20 MB each), as single files or ZIPs; the real file type is checked from
   its bytes, and anything else is listed as rejected with the reason.
2. **Read, clean, group** (worker): prices to cents, weights to grams, inches to cm, broken text and HTML fixed, rows grouped
   into products. Shopify and WooCommerce exports are recognised.
3. **Photos** (worker, in parallel): each photo is turned the right way up, stripped of camera and location data,
   and saved as a WebP copy plus a thumbnail. The same picture uploaded twice is stored once. Photos are matched
   to products by name, no AI needed: a row that names the file (image column), then a file named after a SKU
   or parent SKU, then a SKU already in the catalog. Case, folders and copy numbers like " (1)" don't matter.
   Photos that match nothing are listed with the reason, and so are files the sheet names that weren't uploaded.
   Links in the image column (a Shopify export's `https://cdn.shopify.com/...`) are downloaded and go through the
   same steps, unless that file was also uploaded. They're treated as hostile: only http(s), never an address on
   this machine or a private network (checked again after every redirect and at connect time), 15 seconds, 20 MB,
   and it must really be a photo. A busy website gets 3 tries; a link that doesn't work ends as rejected with the
   reason. A link downloaded once isn't downloaded again on a re-upload.
4. **AI step** (worker): products go to the AI in batches of 10. The AI writes title, description, category,
   tags, attributes and claims. Our code checks every answer: claims must quote the supplier's exact words
   (and not words that deny them), categories must come from a fixed list, low confidence goes to review, and a
   description sentence that adds details the supplier never gave goes to review with that sentence shown.
   Prices, SKUs, sizes and weights never come from the AI.
5. **Translation** (worker): each product is translated into the shop's languages (German and French) right after
   it's written, 10 products per call, one language at a time. Only languages switched on for some country are
   translated (Germany and Austria get German, France gets French, everyone else English; `country_languages`).
   Each field (title, description, tags, attributes, option names and values) remembers the English it came from,
   so when only the title changes, only the title is translated again. Our code checks every translation: the
   HTML tags, every number and unit, codes like FSC or E27 and placeholders like `{{count}}` must survive, the
   text must really be translated, and a claim must not get stronger ("frost-resistant (not frost-proof)" must not
   become "frostfest", a "not" must not go missing). A translation that fails gets one more try, with the problems
   spelled out, on the stronger model; if it still fails, shoppers see the English for that field and the merchant
   sees why. Categories have fixed German and French names (no AI). A merchant's own translation always wins: the
   AI never overwrites it, and when the English changes it's kept and shown as out of date.
6. Every row ends as **done**, **needs review** or **failed**, every photo as **matched**, **unmatched** or
   **rejected**, every product is translated (or its translation failed, with the reason), and then the import is
   **done**. Shoppers never wait for the AI: everything they see was translated ahead of time.

Re-uploads: a product whose rows haven't changed costs no AI call. When only prices, stock or variants changed,
or a later file has no product text of its own (a price list), the listing is kept and only prices and variants
are updated, so a thin file can't wipe a good listing. New or changed description text gets a fresh listing.

AI options (`AI_PROVIDER` in `.env.local`):

- `deepseek`: clean products go to `deepseek-flash`, messy ones (German/French text, conflicts, missing names) to
  the stronger `deepseek-v4-pro`. Thinking is turned off (same answers, far fewer paid tokens). Calls are spaced
  out to stay under the requests-per-minute limit; on "too many requests" every worker pauses and the import shows
  "Paused" until it resumes on its own. When the account runs out of credit, imports pause too instead of failing
  their rows, check again every 2 minutes (a refused call costs nothing), and carry on once it's topped up.
  Needs `DEEPSEEK_API_KEY`.
- `mock`: works offline and costs nothing (tests, demo mode, large speed tests). `MOCK_AI_MODE` makes it misbehave
  on purpose (invent claims, fail, hit the rate limit, run out of credit, cut off its answer, send broken JSON, skip
  translating) to show the checks catch it.

Every AI call is recorded with its tokens, time and cost at DeepSeek's published prices (`ai_calls`), including
the cheaper rate for repeated input and the peak/off-peak prices.

Measured with real DeepSeek on a 1,000-row sheet, 4 batches in parallel: 4.1 s per batch of 10 products, the whole
sheet in about 3 minutes (including a worker crash halfway), $0.19 per 1,000 products at peak price ($0.09 off-peak).
Translating into German and French: $0.23 per 1,000 products for both languages together, off-peak (37 real
products, 23 calls, every negation and qualifier kept).

## Scripts

| Script | What it does |
|---|---|
| `pnpm db:up` / `pnpm db:down` | Start / stop Postgres in Docker |
| `pnpm db:generate` | Create a migration after changing `src/server/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:studio` | Browse the database in the browser |
| `pnpm worker` | Run the background worker (`worker:dev` restarts on file changes) |
| `pnpm import:file <file> [--photos <folder or zip>]` | Upload a sheet (and photos) through the API and print the result for every row and photo |
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
                    the background job that runs them (run-parse-import.ts), and the AI step (build.ts)
    ai/             prompt, answer shape, claim and category checks (verify.ts), mock AI, category list
    photos/         photo uploads and ZIPs (upload.ts), resizing (process.ts), matching photos to products (match.ts)
    translations/   what's translated (fields.ts), the checks (checks.ts), the translation job (run.ts), what shoppers
                    see (localize.ts), the merchant's own translations (merchant.ts), languages per country
    imports/        creating an import, reading its status, and the watchdog that restarts stuck imports
    storage/        where uploaded files are saved (a local folder for now)
  worker/           the background worker
scripts/            terminal scripts for testing
samples/            test sheets: messy supplier sheets, Shopify and WooCommerce exports, German and French files,
                    a messy Excel layout, broken files, a 5,000-row sheet, and photos (samples/test-files)
drizzle/            SQL migrations
docker/             Postgres init (creates the test database)
```

## Technical write-up

(Draft. Numbers marked "to measure" come from the final runs.)

**What was the hardest part?** *(to write in your own words)* Candidates: making the AI's output trustworthy
(sentences it invents that no claim list catches, and claims whose strength changes across languages:
"frost-resistant" vs "frost-proof", "frostbeständig" vs "frostfest"), and making a crash at any moment safe
(attempt numbers, jobs queued in the same transaction as the work they stand for).

**How did you make extraction accurate, and how did you stop invented claims?** See "Accuracy" above.

**Measured numbers** (one Apple M3 laptop, 8 cores, running the web server, the worker, Postgres and the load
generator at once; production build; `AI_CONCURRENCY=2`, one worker):
- **Rows per minute, our pipeline:** a 10,000-row sheet (5,733 products) read, cleaned, grouped, written and
  translated into German and French in 32.6 s, about **18,400 rows a minute**, 0 failed. That's with the mock AI,
  which answers instantly, so it measures our own code, the queue and the database.
- **Rows per minute with the real AI** (DeepSeek, 1,000 rows -> 931 products, 4 batches in parallel, off-peak):
  every product written in 3 min 8 s (**about 320 rows a minute**), and translated into German and French too
  after 6 min (**about 167 rows a minute**). 284 calls, 0 failed, about 4 s per call, 0 translations that fell back
  to English. The limit was our own cap of 60 AI calls a minute (`AI_REQUESTS_PER_MINUTE`), not our code: raising
  it, or adding workers, speeds this up until the provider's own limit.
- **Storefront latency during an import** (autocannon, 20 visitors at once on the collection page and a product
  page, 4,061 approved products):

  | | Requests a second | Average | 99% under | Errors |
  |---|---|---|---|---|
  | Nothing running | ~177 | 109–117 ms | ~195 ms | 0 |
  | While a 10,000-row import runs | ~133 | ~150 ms | ~550 ms | 0 |

  The import still finished in 60 s (about 9,900 rows a minute) while serving that load. The slowdown is the
  worker and the web server sharing one laptop's CPU; deployed, the worker runs on its own machine.
- **Cost per 1,000 products** with real DeepSeek, off-peak: **$0.26** in all ($0.09 to write them, $0.17 to translate
  them into German and French). At peak prices it's double.

**What breaks first at 1,000,000 products in 8 languages, and how would you fix it?**
1. **AI throughput.** About 100,000 calls to write the products and 800,000 to translate them. At 60 calls a
   minute that's over 10 days. Fix: the provider's batch API where there is one (cheaper, no rate limit per call),
   several keys or providers behind the same pause logic, translating approved products first, and a translation
   memory so repeated text (tags, attribute values, colours) is translated once for the whole catalog.
2. **The rate-limit row.** Every call takes its time slot from one row per provider. At hundreds of calls a second
   that row becomes the bottleneck. Fix: hand out slots in blocks per worker, or keep them in Redis.
3. **Counting queries.** 40 million translation rows (1M products x 8 languages x 5 fields): coverage and "is the
   import done" queries that count rows get slow. Fix: per-import and per-language counters updated with the rows,
   or summary tables refreshed in the background.
4. **Storage and search.** Photos on local disk move to object storage behind a CDN; the product list needs
   keyset pagination and a search index (pg_trgm or full-text) instead of OFFSET and ILIKE.

**What did you learn?** *(to write in your own words)*

**How did you use AI while building this?** *(to write in your own words)*

