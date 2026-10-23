# CatalogForge

Turns a messy supplier spreadsheet and product photos into a clean, translated product catalog.

Work in progress. See [EDGE-CASES.md](EDGE-CASES.md) for what can go wrong and how the app handles it.

(Screenshots of the upload, review, metrics and shop pages go here.)

## Architecture

```
 Browser: dashboard (upload, review, metrics) and storefront
    |  upload returns at once with an import id
    v
 Next.js: API routes and pages  ----reads/writes---->  Postgres  <----reads/writes----  Worker (Node)
                                                         |                                 |
                                       data: imports, rows, products,              only the worker calls
                                       variants, photos, translations,             the AI (Claude)
                                       AI calls and cache
                                       queue: pg-boss jobs, in the same database
```

One database holds the data and the job queue (pg-boss). A job is queued in the same transaction that records
why it's needed, so work is never lost and never queued twice. (Translations are the one two-step case: they're
marked when the product is saved and queued right after; the watchdog queues any left behind.) The worker runs
the jobs:

1. `parse-import`: read the file, clean every row, group rows into products, match photos, plan the AI batches
2. `build-batch`: 10 products per AI call, checked in code, saved
3. `translate-batch`: 10 products per call, one language at a time, checked in code, saved
4. `process-photos`: 50 photos per job, resized, in parallel with the rest
5. `watchdog`: every minute, restarts anything whose job went missing

Each job has a dead-letter queue: when a job fails every try, its import, rows or translations are marked failed
(photos: rejected) with the reason, so an import always ends.

The storefront only reads Postgres. It never calls the AI and never waits for an import.

## Scale and reliability

- **The upload returns at once.** All the work runs in the queue, in batches.
- **At most 10,000 rows per import.** A bigger sheet fails as soon as the worker reads it, before any row is saved
  or the AI is asked: "The sheet has 10,001 rows. The limit is 10,000 per import. Split it into smaller files".
- **Every step can run twice without harm.** Rows are unique per import and row number, products are updated by
  their key or SKU, variants by SKU, photos by import and file name, translations by product, language and field.
  An AI answer is saved under a hash of its question, so a batch that runs again after a crash pays nothing for
  answers that already came back. Only calls cut off mid-flight are paid twice.
- **A restart loses nothing.** The import remembers its stage. A worker that dies stops sending heartbeats and its
  job goes to another worker (or to the same one when it starts again). A worker that only froze can't overwrite
  newer work: reading the sheet checks it still holds the import's newest attempt number, and an AI batch only
  saves products whose rows are still waiting, with the product row locked. The watchdog restarts imports, AI
  batches, photos and translations whose job went missing. After 3 restarts it stops: an import still being read
  fails with a clear message, and one in the AI step fails its remaining rows, so the import still ends.
- **No duplicates.** The same file can't be imported twice at the same time (a unique index, so even two uploads
  in the same millisecond end up as one). The same products from a differently laid out file are matched by SKU.
  Web addresses (handles) are given out under a lock.
- **AI failures and limits.** Timeouts, "overloaded" and server errors fail the job, which runs again after about
  10, 20 and 40 s. Broken JSON is asked again with the error explained, then on the stronger model. A cut-off
  answer is split in half. "Too many requests" pauses every worker at once; when the wait is over 90 s the batch
  goes back in the queue for that time without using up a try, and while products are being written the import
  shows "Paused" with how long until it resumes. An empty account pauses too, checks for a top-up every 2 minutes
  (a refused call costs nothing) and carries on by itself. A batch that fails every try marks its rows Failed with
  the reason.
- **How fast the AI goes is a setting.** Each worker writes `AI_CONCURRENCY` batches and translates
  `AI_TRANSLATE_CONCURRENCY` batches at once, and all workers together stay under `AI_REQUESTS_PER_MINUTE` (time
  slots are handed out from one row in Postgres). See "AI options" for the values used with Claude.
- **Every row ends as Done, Needs review or Failed**, and the counts always add up to the sheet. They're counted
  from the rows themselves, never kept as +1 counters that a retry could get wrong.

Crash test with real Claude: the 5,000-row sheet (`samples/test-files/08-big/big_5000_rows.csv`, 6 batches written
and 6 translated at once), worker killed with `kill -9` at 32% (1,584 of 5,000 rows), started again about 14 s
later. The 12 batches that were mid-flight were picked up again within about 30 s (job heartbeats). The dashboard
and the shop kept answering while the worker was down.

| What | Result |
|---|---|
| Rows | 5,000 final: 1,822 Done, 3,178 Needs review, 0 Failed |
| Products | 3,725, with 0 duplicate products, SKUs or translations |
| AI calls | 373 product batches, exactly 373 successful calls. Only the ~12 calls cut off mid-flight were paid twice (about a cent) |
| Time | 20 min 21 s, crash included |
| Cost | $1.34 ($0.49 writing, $0.85 translating) = $0.36 per 1,000 products |

## Cost

- **Routing:** clean products go to the cheap model (`claude-haiku-5-5`), messy ones (German or French text, a
  problem with a name or SKU, a description over 2,000 characters) to the stronger one (`claude-sonnet-5-5`).
  Translations use the cheap model and only ask the stronger one when our checks find a problem or the answer is
  broken twice.
- **Batching:** 10 products per call, so the instructions are paid once per batch, not per product. They're the
  same on every call and marked for Claude's prompt cache, so while calls keep coming (the cache lasts 5 minutes)
  they're billed at a tenth of the input price or less.
- **Never paying twice:** our own cache of AI answers; unchanged rows on a re-upload skip the AI; a price list
  that brings no new product text only updates prices; only the translation fields whose English changed are
  translated again; languages no country uses aren't translated at all.
- **No AI where code does it:** prices, units, variants, grouping, photo matching, category names in German and
  French, SEO fields.
- **Tracked:** every call's tokens, time, cost, model and purpose, per import, with how many products it covered
  (`ai_calls`).

Measured with real Claude:

| Run | Products | Writing | Translating (German + French) | Total | Per 1,000 products |
|---|---|---|---|---|---|
| 10,000 rows | 6,302 | $0.85 | $1.49 | $2.34 | $0.37 |
| 5,000 rows, worker killed at 32% | 3,725 | $0.49 | $0.85 | $1.34 | $0.36 |

Rebuilding 5,000 rows from the saved AI answers after changing only our checks took 1 min 27 s and cost $0 for
writing (translating the fields that changed: about $0.46). Total AI spend for a full day of testing with
Claude: $5.52. The Metrics tab shows the live figures, and what routing, batching and the answer cache saved.

## Accuracy: how invented claims are stopped

- **Code, not the AI, does the facts.** Prices become integer cents with a currency, weights become grams, sizes
  keep their metric unit (inches become cm), colours are matched against a list, rows are grouped into products and
  variants. The AI never sets a price, SKU, size or weight. When the same SKU comes with two prices, it gets no
  price until the merchant enters one.
- **Every claim must quote the supplier.** The AI gives the row, column and exact words for each claim. Code checks
  the words are really in the supplier's text (that cell, or else another cell of the product) and that they don't
  deny the claim ("not frost-proof", "nicht frostfest"), using a list of risky claims in English, German and
  French. Care and safety instructions count as claims ("machine washable", "dry clean only"). A "not" only counts
  inside its own sentence. A partial claim ("organic cotton blend") doesn't back a full one ("organic cotton"). A
  claim that fails is removed and the product goes to review.
- **Invented details are caught too.** A description sentence with two or more words the supplier never used goes
  to review, with the sentence shown ("for marking plants in beds, pots and seed trays"). English sheets only: a
  translation shares no words with the German or French it came from.
- **Unsure extras are left out.** A tag the supplier doesn't back is dropped, and so is an attribute the AI scores
  under 70%. They're extras the AI offers, not something to send to review.
- **Unclear means review, not a guess:** a title, description, category or tags scored under 70%, conflicting rows,
  a missing price, a category outside the fixed list, text that looks like instructions to the AI (removed before
  the AI sees it), a note that doesn't fit the product.
- **Translations are checked the same way:** a translation can't make a claim stronger or drop a "not", every
  number, unit, code and HTML tag must survive, and the title and description must really be translated.
- **Tested on real messy files** with the real AI, fixing what they showed (see the commit history).

Why products were in review after the 10,000-row run (1,689 of 6,302 products, 27%; a product can have more than
one reason):

| Reason | Products |
|---|---|
| Price problems planted in the sheet: no price (322), "on request" (224), mixed currencies (136) | about 680 |
| A note that doesn't fit the product. The test generator attaches random notes like "frost-resistant" to cushion covers, and Claude flags them, correctly | about 908 |
| Noise, mostly "material taken from the product name" | about 140 (about 2% of products) |

Earlier the same sheet had 64% of its rows in review. The fixes: leaving out attributes the AI is unsure of,
reading bare weights in the column's unit, joining rows to their family, and stricter rules for when the AI may
flag something.

## Run it locally

Needs Node 22.12+, pnpm and Docker.

```bash
pnpm install
cp .env.example .env.local
pnpm db:up          # Postgres in Docker, on port 5433
pnpm db:migrate     # create the tables
```

`.env.example` starts with the mock AI (offline, free). For Claude, set `AI_PROVIDER=anthropic` and
`ANTHROPIC_API_KEY` in `.env.local` (see "AI options" for the speed settings).

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

- **Upload** (`/`): drop a CSV or XLSX sheet plus photos (files, folders or a ZIP). The upload panel follows the
  import live and ends with a link to the products to review ("Review 2 products"). Each import's card shows rows
  done / needs review / failed, photos, translations per language, "Paused" with how long until it resumes, how
  many products were new and how many already in the catalog ("6 products: 4 new, 2 already in your catalog
  (updated)"), and "Try failed ones again". "Rows and photos" opens its rows with the reason for each, and its
  photo report.
- **Products** (`/products`): the catalog with search, filters, sortable columns, 10/25/50/100 per page and
  colour-coded confidence. Bulk approve (it asks first when some of the picked products need review) and export
  (CSV, JSON, Shopify). A product's review screen shows the supplier's rows and photos next to what the AI wrote,
  with every claim's source, and lets you edit, approve, send back, fix translations and assign photos. Edit
  includes the variants' prices: a price you type wins over later uploads, and if the supplier's sheet later says
  something else, that price is shown next to yours.
- **Update waiting:** when a re-upload makes the AI rewrite an approved product, the shop keeps showing the
  approved listing. The new one waits on the product page, next to the current one, until you pick "Use the new
  version" or "Keep the current one". The Products tab has a filter for these.
- **Metrics** (`/metrics`): success, review and failure rates, cost per 1,000 products, cost over time, model use,
  speed, problems, why products need review (grouped by kind, with an example of each), translation coverage,
  money saved by routing, batching and the answer cache.
- **Languages** (`/languages`): switch countries on or off (Germany, Austria, Switzerland, Liechtenstein -> German;
  France, Belgium, Luxembourg, Monaco -> French). Switching on a language no country showed yet translates the
  catalog into it in the background. Shows coverage per language and lets you retry failed translations.
- **Storefront** (`/shop`): approved products only, in the visitor's language by country (Germany and Austria get
  German, France gets French, everyone else English; a switcher in the header, or `?country=DE`). Pages are read
  from a short cache, never from the AI. They update the moment the merchant approves or changes a product; what
  the worker changes (new translations, new prices) shows after about a minute (the cache's refresh time).
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
| `GET /api/products?page=&pageSize=&sort=&order=&search=&status=&category=&importId=&maxConfidence=&updateWaiting=&deleted=` | The catalog for the Products tab: 10/25/50/100 per page, sortable, search by title, handle or SKU |
| `GET /api/products/:id` | Everything for the review screen: the AI's fields with confidence, claims with sources, variants, photos, the supplier's rows next to them, translation state, a new version waiting |
| `PATCH /api/products/:id` | The merchant edits the English (title, description, category, tags, attributes) and variant prices (`"prices": { "TC-PL-30": "21.50" }`). Edited fields and typed prices are never overwritten by a re-upload; only changed fields are translated again |
| `POST /api/products/:id/approve` | Shows it in the storefront. Refused while a variant has no price |
| `POST /api/products/:id/send-back` | `{ "reason": "..." }`: back to Needs review with the merchant's reason |
| `POST /api/products/:id/new-version` / `DELETE` | Use the new listing that's waiting (stays approved, translations redone) / keep the current one (the same sheet uploaded again won't bring it back) |
| `POST /api/products/bulk-approve` | `{ "ids": [...] }` or `{ "importId": "..." }` (its ready products). Products in Needs review are left out and listed, unless `"includeNeedsReview": true`. Says which were skipped and why |
| `DELETE /api/products/:id` / `POST /api/products/:id/restore` | Soft delete (gone from the storefront and exports, kept so a re-upload doesn't bring it back) / restore |
| `GET /api/export?format=csv\|json\|shopify&status=approved\|ready\|all&language=en\|de\|fr` | Download the catalog: CSV (a row per variant), JSON (the brief's format plus photos and translations) or Shopify's product CSV. Streams 200 products at a time |
| `GET /api/metrics?days=` | The Metrics tab: rates, imports and speed, AI calls and cost by model and purpose, cost over time, problems, why products need review, translation coverage, money saved (estimates, each with its method) |
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
2. **Read, clean, group** (worker): at most 10,000 rows. Prices to cents, weights to grams, inches to cm (metric
   sizes keep their unit), broken text and HTML fixed, rows grouped into products. A weight without a unit is read
   in the column's unit (from the header, or the unit most of the column uses, if the number fits its range);
   otherwise it goes to review. A row without a Parent SKU joins the family its SKU starts with when the name is
   the same. Shopify and WooCommerce exports are recognised.
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
   (and not words that deny them, or only back them in part), categories must come from a fixed list, tags the
   supplier doesn't back are dropped, unsure attributes are left out, other fields under 70% confidence go to
   review, and a description sentence that adds details the supplier never gave goes to review with that sentence
   shown. Prices, SKUs, sizes and weights never come from the AI.
5. **Translation** (worker): each product is translated into the shop's languages (German and French) right after
   it's written, 10 products per call, one language at a time. Only languages switched on for some country are
   translated (Germany and Austria get German, France gets French, everyone else English; `country_languages`).
   Each field (title, description, tags, attributes, option names and values) remembers the English it came from,
   so when only the title changes, only the title is translated again. Our code checks every translation: the
   HTML tags, every number and unit, codes like FSC or E27 and placeholders like `{{count}}` must survive, the
   title and description must really be translated, and a claim must not get stronger ("frost-resistant (not frost-proof)"
   must not become "frostfest", a "not" must not go missing). A translation that fails gets one more try, with the
   problems spelled out, on the stronger model; if it still fails, shoppers see the English for that field and the
   merchant sees why. Categories have fixed German and French names (no AI). A merchant's own translation always
   wins: the AI never overwrites it, and when the English changes it's kept and shown as out of date.
6. Every row ends as **done**, **needs review** or **failed**, every photo as **matched**, **unmatched** or
   **rejected**, every product is translated (or its translation failed, with the reason), and then the import is
   **done**. Shoppers never wait for the AI: everything they see was translated ahead of time.

Re-uploads: a product whose rows haven't changed costs no AI call (unless our AI instructions changed since, see
`PROMPT_VERSION`). When only prices, stock or variants changed, or a later file has no product text of its own (a
price list), the listing is kept and only prices and variants are updated, so a thin file can't wipe a good
listing. New or changed description text gets a fresh listing. For an approved product that fresh listing waits as
"Update waiting" while the shop keeps the approved one; prices and variants from the new sheet apply straight
away. A re-upload that changes nothing leaves the products' "updated" time alone.

AI options (`AI_PROVIDER` in `.env.local`):

- `anthropic` (Claude, the main one): clean products go to `claude-haiku-5-5`, messy ones to the stronger
  `claude-sonnet-5-5` (`ANTHROPIC_MODEL_CHEAP` / `ANTHROPIC_MODEL_STRONG` to change them). Thinking is turned off
  (it costs output tokens and time; our checks do the careful part). The instructions are marked for Claude's
  prompt cache. Answers are JSON: the shape is in the instructions and zod checks every answer (Claude's strict
  JSON mode can't describe maps with free keys, like attributes and confidence). Rate limits, an empty account or a
  spending limit pause the import as described above. Needs `ANTHROPIC_API_KEY`.
- `deepseek`: the same with `deepseek-flash` and `deepseek-v4-pro`. Needs `DEEPSEEK_API_KEY`.
- `mock`: works offline and costs nothing (tests, demo mode, large speed tests). `MOCK_AI_MODE` makes it misbehave
  on purpose (invent claims, fail, hit the rate limit, run out of credit, cut off its answer, send broken JSON, skip
  translating) to show the checks catch it.

Speed settings: `AI_REQUESTS_PER_MINUTE` (all workers together, default 60), `AI_CONCURRENCY` (batches written at
once per worker, default 2) and `AI_TRANSLATE_CONCURRENCY` (batches translated at once, next to those; defaults to
`AI_CONCURRENCY`). For Claude we use 300 / 10 / 12: about 80% of our account's 400,000 output tokens a minute.
At 10 and 16 we hit the limit a few times, and the app paused and carried on by itself.

Every AI call is recorded with its tokens, time and cost at the provider's published prices (`ai_calls`,
`src/server/ai/pricing.ts`), including Claude's prompt cache (writing it costs a little more than normal input,
reading it far less) and DeepSeek's cheaper repeated input and peak/off-peak prices.

## Scripts

| Script | What it does |
|---|---|
| `pnpm db:up` / `pnpm db:down` | Start / stop Postgres in Docker |
| `pnpm db:generate` | Create a migration after changing `src/server/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:studio` | Browse the database in the browser |
| `pnpm worker` | Run the background worker (`worker:dev` restarts on file changes) |
| `pnpm worker:demo-pause` | A worker with the mock AI whose first call hits a 2-minute rate limit: the import shows "Paused" and carries on by itself. Start it instead of `pnpm worker`, and upload a sheet with new products (unchanged ones skip the AI) |
| `pnpm worker:demo-fail` | A worker with the mock AI whose first 4 calls fail: a small sheet's rows end up Failed after their retries, and "Try failed ones again" then works. Same rules as above |
| `pnpm build` / `pnpm start` | Production build of the web app / serve it (used for the storefront speed numbers) |
| `pnpm queue:ping` | Send a test job and wait for the worker to finish it |
| `pnpm import:file <file> [--photos <folder or zip>]` | Upload a sheet (and photos) through the API and print the result for every row and photo |
| `pnpm reset:data --yes` | Empty the app (imports, products, translations, photos, AI calls, uploaded files) before a demo or deploy. Keeps the language settings, refuses while an import runs |
| `pnpm test` | Run tests against a separate test database |
| `pnpm typecheck` / `pnpm lint` | Type check / lint |

## Layout

```
src/
  app/
    (dashboard)/    the dashboard pages: Upload, Products, Metrics, Languages
    shop/           the storefront
    _components/    the dashboard's UI
    api/            API routes
  server/
    db/             tables (schema.ts) and the database connection
    queue/          pg-boss setup and the list of queues
    pipeline/       reading sheets (read-sheet.ts), cleaning rows (clean/), grouping rows into products (group.ts),
                    the background job that runs them (run-parse-import.ts), and the AI step (build.ts)
    ai/             Claude, DeepSeek and mock AI, asking with the answer cache and rate limit (ask.ts), prices,
                    prompt, answer shape, claim and category checks (verify.ts, claims.ts), category list
    photos/         photo uploads and ZIPs (upload.ts), links (download.ts), resizing (process.ts), matching photos
                    to products (match.ts)
    translations/   what's translated (fields.ts), the checks (checks.ts), the translation job (run.ts), what shoppers
                    see (localize.ts), the merchant's own translations (merchant.ts), languages per country
    imports/        creating an import, reading its status, retrying, and the watchdog that restarts stuck imports
    products/       the catalog list, the review screen's data, approve / edit / send back / new version
    metrics/        the Metrics tab's numbers, money saved, why products need review
    export/         CSV, JSON and Shopify exports
    storefront/     what the shop reads, its cache, country to language
    storage/        where uploaded files are saved (a local folder for now)
  worker/           the background worker
  test/             test setup (separate database, queue)
scripts/            terminal scripts for testing
samples/            test sheets: messy supplier sheets, Shopify and WooCommerce exports, German and French files,
                    a messy Excel layout, broken files, a 5,000-row sheet, and photos (samples/test-files)
drizzle/            SQL migrations
docker/             Postgres init (creates the test database)
```

## Tech stack and design decisions

Next.js 16 (dashboard, storefront and API in one app), Postgres 17 with Drizzle, pg-boss 12 as the queue, a Node
worker, zod for AI answers and API input, sharp for photos, papaparse and SheetJS for sheets, Tailwind, Vitest
against a real test database.

- **Postgres is also the queue.** A job is inserted in the same transaction as the rows that say why it's needed,
  so a crash can't leave work recorded but not queued, or queued twice. One service to run and back up, and the
  watchdog finds a missing job with plain SQL. Trade-off: workers poll Postgres for jobs (every second for AI and
  photo batches), and at much higher volume the queue and the shared rate-limit row compete with the app for the
  same database.
- **Code does the facts, the AI only writes text.** Prices, SKUs, units, variants, grouping and photo matching are
  plain code with tests, so the AI can't get them wrong: it never sets them. The AI writes the title, description,
  category, tags, attributes and claims, and code checks them against the supplier's words. Trade-off: the
  cleaning code has to know each messy format ("21,50", "on request", inches); what it doesn't recognise goes to
  review instead of being guessed, so the merchant sees more review than a "let the AI guess" design would.
- **10 products per AI call.** The instructions (about 7,000 characters with the answer's shape) are sent once per
  10 products instead of once per product, and a failed call affects only 10 products. The answer for 10 has to fit
  in the 8,192-token output cap; one that's cut off is split in half. Trade-off: a broken answer means asking again
  for all 10.
- **Prices are integer cents with a currency.** The price text is turned into cents with integer maths, never a
  float, so 0.1 + 0.2 problems can't happen. The currency stays with every price, so a product with prices in two
  currencies goes to review instead of being added up. AI costs are stored the same way, in millionths of a
  dollar. Trade-off: two decimals are assumed for every currency.
- **Translations are checked in code.** A translation can quietly make a claim stronger ("frost-resistant" ->
  "frostfest", which means frost-proof) or drop a "not". Code compares claims, negations, numbers, units, codes,
  placeholders and HTML tags between the English and the translation; a field that still fails after a retry on
  the stronger model is shown in English, with the reason. Trade-off: the checks are word lists in three
  languages, so a new risky claim or a new language means adding words by hand.
- **An approved product's rewrite waits as "Update waiting".** Approved means the merchant has checked what
  shoppers see, so a re-upload shouldn't change it unseen. The new listing is saved next to the live one, and the
  merchant uses it or keeps the current one; prices and variants from the sheet still apply straight away.
  Trade-off: one more click for the merchant, and new AI instructions (`PROMPT_VERSION`) rewrite every product on
  its next upload, which can put many approved products in "Update waiting" at once.

## Technical write-up

(Draft.)

**What was the hardest part?** *(to write in your own words)* Candidates: making the AI's output trustworthy
(sentences it invents that no claim list catches, and claims whose strength changes across languages:
"frost-resistant" vs "frost-proof", "frostbeständig" vs "frostfest"), and making a crash at any moment safe
(attempt numbers, jobs queued in the same transaction as the work they stand for).

**How did you make extraction accurate, and how did you stop invented claims?** See "Accuracy" above.

**Measured numbers** (real Claude, `claude-haiku-5-5` and `claude-sonnet-5-5`):

- **Rows per minute with the real AI:**

  | Run | Batches at once (writing / translating) | All rows written | Written and translated |
  |---|---|---|---|
  | 10,000 rows -> 6,302 products | 10 / 16 | 14 min 30 s (689 rows a minute) | 20 min 22 s (491 rows a minute) |
  | 5,000 rows -> 3,725 products, worker killed at 32% | 6 / 6 | | 20 min 21 s, crash included (245 rows a minute) |

  The 10,000-row run ended with 7,054 rows Done, 2,946 Needs review, 0 Failed; 6,302 products (4,613 ready, 1,689
  in review); 12,604 translations, 0 flagged; 0 duplicate SKUs; 1,152 rows without a Parent SKU joined their
  family; 782 weights without a unit read as kg (the column's unit). Its time includes a Claude slowdown with
  timeouts and a few rate-limit pauses: 43 AI hiccups, all retried, nothing lost. At 10 and 16 batches at once we
  hit our account's limit of 400,000 output tokens a minute a few times, so more speed needs a higher limit, not
  more workers.
- **Our own pipeline**, with the mock AI (it answers instantly, so this measures our code, the queue and the
  database; an earlier run, before the switch to Claude): a 10,000-row sheet (5,733 products) read, cleaned,
  grouped, written and translated in 32.6 s, about 18,400 rows a minute, 0 failed.
- **10,001 rows:** refused in about 1 s with "The sheet has 10,001 rows. The limit is 10,000 per import. Split it
  into smaller files"; 0 rows saved, 0 AI calls.
- **Storefront latency** (production build, `next build` + `next start`; autocannon, 20 connections, 20 to 30 s
  per run; 2,318 approved products; one laptop also running the worker and Postgres). A single request takes
  about 10 ms.

  | | Requests a second | Average | 99% under |
  |---|---|---|---|
  | Shop page, nothing running | 160 | 124 ms | 225 ms |
  | Product page, nothing running | 178 | 111 ms | 144 ms |
  | Shop page, during the 10,000-row import's AI writing | 143 | 139 ms | 308 ms |
  | Product page, during it | 151 | 132 ms | 505 ms |

  0 errors and 0 timeouts in all runs (about 15,600 requests). The slowdown is the worker and the web server
  sharing one laptop; they're separate processes, so the worker can run on its own machine.
- **Cost per 1,000 products:** $0.37 (10,000 rows) and $0.36 (5,000 rows with a crash), writing and translating
  into German and French included. See "Cost".

**What breaks first at 1,000,000 products in 8 languages, and how would you fix it?**
1. **AI throughput.** About 100,000 calls to write the products and 800,000 to translate them. The 10,000-row run
   made 6,302 products in English, German and French in 20 min 22 s on one Claude account, hitting its output
   limit a few times; 1,000,000 products at that pace is about 54 hours for those 3 languages alone. Fix: Claude's
   Message Batches API for the bulk (half the price, with its own limits instead of the per-minute ones), several
   accounts behind the same pause logic, translating approved products first, and a translation memory so repeated
   text (tags, attribute values, colours) is translated once for the whole catalog.
2. **The rate-limit row.** Every call takes its time slot from one row per provider. At hundreds of calls a second
   that row becomes the bottleneck. Fix: hand out slots in blocks per worker, or keep them in Redis.
3. **Counting queries.** 40 million translation rows (1M products x 8 languages x 5 fields): coverage and "is the
   import done" queries that count rows get slow. Fix: per-import and per-language counters updated with the rows,
   or summary tables refreshed in the background.
4. **Storage and search.** Photos on local disk move to object storage behind a CDN; the product list needs
   keyset pagination and a search index (pg_trgm or full-text) instead of OFFSET and ILIKE.

**What did you learn?** *(to write in your own words)*

**How did you use AI while building this?** *(to write in your own words)*
