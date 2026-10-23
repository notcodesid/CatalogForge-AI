# Architecture

[Back to the README](../README.md)

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

## Code layout

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
