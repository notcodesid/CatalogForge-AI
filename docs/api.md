# API

[Back to the README](../README.md)

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
