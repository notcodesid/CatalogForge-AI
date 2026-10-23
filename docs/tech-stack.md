# Tech stack and design decisions

[Back to the README](../README.md)

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
