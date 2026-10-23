# Using the app

[Back to the README](../README.md)

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
