# Edge Cases

## Messy input

### File is broken, empty, or in the wrong format
- **What happens:** The upload is a corrupt file, an empty file, or not really a CSV/XLSX (like a PDF renamed to .csv)
- **What the app does:** The upload checks the file's first bytes, not its name. Empty files, PDFs, images, other binary files and files over 25 MB are refused before anything is saved. A damaged or password-protected XLSX, a sheet with no header row, or one with no product rows fails the import with a clear message and no rows saved
- **Status:** Handled
- **Tested by:** `read-sheet.test.ts`, `create-import.test.ts`, `run-parse-import.test.ts`

### Prices in different formats, or missing
- **What happens:** Prices like `1.299,00 €`, `12.5`, `£8`, or empty
- **What the app does:** Code (not the AI) turns every price into integer cents and a currency code: `1.299,00 €`, `£8`, `1'299.50 CHF`. A missing, zero, negative or unclear price ("on request", or `1,299` when the rest of the column doesn't show which separator is the decimal) goes to Needs review and the variant is saved without a price. With no currency anywhere, it takes the currency of the product's other variants, else the import's default, with a note
- **Status:** Handled
- **Tested by:** `price.test.ts`, `group.test.ts`

### Same SKU appears twice with different data
- **What happens:** SKU `TC-PL-20` is on two rows with different prices
- **What the app does:** Exact copies are merged into one. Different prices: the variant is saved with no price and a reason like "Rows 10 and 11 have the same SKU CW-15 but different prices (€32.00 vs €36.00). Enter the right one with Edit". Other differences (name, size, weight...) go to Needs review with both values
- **Status:** Handled (tested with real Claude)
- **Tested by:** `group.test.ts`, `build.test.ts`, real run (Round 1 sheet, CW-15 at €32 and €36)

### Required fields missing (title, price)
- **What happens:** A row has no title or no price
- **What the app does:** No name: Needs review with "No product name, the AI will suggest one", and the stronger model writes one. No price: Needs review, and the product can't be approved until the merchant types a price in Edit or a later sheet has one. A row with no SKU, name or description is marked Failed
- **Status:** Handled
- **Tested by:** `build.test.ts`, `products.test.ts`, `read-sheet.test.ts`

### Mixed units (cm/inch, kg/lbs)
- **What happens:** Sizes in cm and inches, weights in kg and lbs, in the same sheet
- **What the app does:** Code turns inches into cm and every weight (kg, g, lb, oz) into grams. Metric sizes keep the supplier's unit ("100 m" stays "100 m") but compare by millimetres, so "100 cm" and "1 m" are the same size. A value with no unit takes the unit from the column header ("Weight (kg)"); a size with no unit anywhere goes to Needs review (weights: see the next case)
- **Status:** Handled
- **Tested by:** `units.test.ts`, `group.test.ts`

### Weight without a unit
- **What happens:** Most rows say "1.8 kg", a few just say "1.7"
- **What the app does:** If at least 60% of the weights with a unit use one unit, a bare number inside that unit's range of values is read in that unit, with a note on the row. Anything else ("800" next to kg values, or kg and lbs mixed half and half) goes to Needs review
- **Status:** Handled (tested with real Claude)
- **Tested by:** `units.test.ts`, `row.test.ts`, real run (10,000 rows: 782 weights read as kg)

### Description has HTML or script tags
- **What happens:** Supplier descriptions include `<script>` tags, `onclick=` and other unsafe HTML
- **What the app does:** Only `p`, `br`, `ul`, `ol`, `li`, `strong` and `em` are kept, with no attributes. `<script>` and `<style>` go with their content, and the row gets a note. The AI's HTML, the merchant's edits and translations are cleaned the same way
- **Status:** Handled (tested with real Claude)
- **Tested by:** `text-html-color.test.ts`, `verify.test.ts`, `checks.test.ts`, real run (`level3_messy.csv`: `<script>` and `onerror` stripped)

### Very long descriptions
- **What happens:** A description is thousands of words long
- **What the app does:** The full text is kept with the row. The AI (the stronger model) only gets the first 2,000 characters of each cell, and the product goes to Needs review with "The description was too long, the AI only read the first 2,000 characters"
- **Status:** Handled
- **Tested by:** no test yet

### Photos that don’t match any row
- **What happens:** Photos like `IMG_4532.jpg` that don't match any SKU in the sheet
- **What the app does:** Photos match by the file name in the sheet's image column, or by a SKU or parent SKU in the file name (case, separators and copies like " (1)" don't matter). A photo that matches nothing is listed on the import with the reason, and the merchant can put it on a product by hand. It doesn't stop the import
- **Status:** Handled
- **Tested by:** `match.test.ts`, `photos.test.ts`

### Rows for one product are split up or out of order
- **What happens:** The 20 cm and 30 cm sizes of the same planter are on row 14 and row 212
- **What the app does:** The whole sheet is read first, then rows are grouped by Parent SKU, or by the name with sizes, colours and size words removed when the sheet has no parent column. Row order doesn't matter. Rows put together only because their names are similar go to Needs review
- **Status:** Handled
- **Tested by:** `group.test.ts`

### Rows of one product where some have no Parent SKU
- **What happens:** `FXBB-03493-15` has an empty Parent SKU, next to rows whose parent is `FXBB-03493`
- **What the app does:** A row without a parent joins the family its SKU starts with (parent SKU plus a dash), but only if the name is the same, with a note on the row. A row with a different name stays its own product
- **Status:** Handled (tested with real Claude)
- **Tested by:** `group.test.ts`, real run (10,000 rows: 1,152 rows joined their family)

### Typos and text in other languages
- **What happens:** Colours with typos like "terracota", and some rows written in German
- **What the app does:** Colours are matched against a list of 48 colours and their German and French names, allowing 1 or 2 typos ("terracota" → "terracotta", "Grau" → "grey"). A colour not on the list is kept as written, with a note, not a review. German and French rows go to the stronger model, which must write English; if it copies the supplier's text it's asked once more, then the product goes to Needs review
- **Status:** Handled
- **Tested by:** `text-html-color.test.ts`, `build.test.ts`, `verify.test.ts`

### Scents (or other things) in the Colour column
- **What happens:** A candle sheet puts "Lavender" and "Cedar" in the Colour column
- **What the app does:** The AI says what the column really holds (`{"color": "scent"}`), and code only takes a short plain name that doesn't clash with another option. Shoppers see "Scent: lavender", and the name stays when a price list for the same products comes back
- **Status:** Handled (tested with real Claude)
- **Tested by:** `option-names.test.ts`, `verify.test.ts`, `build.test.ts`, real run (Round 1 sheet: scents shown as "Scent")

## AI problems

### AI adds a claim that isn’t in the source
- **What happens:** The AI writes "organic" or "dishwasher-safe" when the supplier never said that
- **What the app does:** The AI must give the row, column and exact words for every claim. Code checks the words are in that sheet and really say it; if not, the claim is removed and the product goes to Needs review. The title, description and attributes are also checked against 26 risky claims (organic, handmade, dishwasher-safe, care instructions...) in English, German and French, a tag the supplier doesn't back is dropped, and on English sheets a description sentence with 2 or more words the supplier never used goes to review
- **Status:** Handled (tested with real Claude)
- **Tested by:** `verify.test.ts`, `build.test.ts`, real run (`level3_messy.csv`: "finished by hand" can't become "handmade", a "ceramic" tag the supplier never wrote is dropped)

### AI makes a claim stronger than the source
- **What happens:** The supplier wrote "frost-resistant (not frost-proof, bring indoors below 0 °C)" and the AI writes "frost-proof"
- **What the app does:** The prompt tells the AI to keep qualifiers. In code, frost-resistant and frost-proof are different claims, so one doesn't back the other, and a "not" just before a claim ("not frost-proof", "nicht frostfest") means the supplier denies it: the claim is removed and the product goes to Needs review. Translations get the same check
- **Status:** Handled (tested with real Claude)
- **Tested by:** `claims.test.ts`, `verify.test.ts`, `checks.test.ts`, real run (`level3_messy.csv`: "frost-resistant (not frost-proof)" stays frost-resistant, "Not dishwasher safe, hand wash only" keeps the "not")

### A partial claim made whole
- **What happens:** The supplier says "organic cotton blend" and the AI writes "organic"
- **What the app does:** Words like "blend", "mix", "contains" or a % within 3 words make a claim partial, and a partial claim only backs a partial one. An "organic" tag is dropped; an "organic" claim, title or description goes to Needs review with "the supplier only says it in part"
- **Status:** Handled (tested with real Claude)
- **Tested by:** `verify.test.ts`, real run (`level3_messy.csv`: tag dropped, claim removed)

### A "not" in one sentence and a claim in the next
- **What happens:** The supplier writes "durable material (not specified). FSC certified"
- **What the app does:** A "not" only counts when it's at most 4 words before the claim, in the same sentence, and it stops at a claim it already denied earlier in that sentence. So FSC stays a claim, and in "Not dishwasher safe, hand wash only" the "not" is about the dishwasher only
- **Status:** Handled
- **Tested by:** `claims.test.ts`, `verify.test.ts`

### AI returns broken JSON
- **What happens:** The AI's response isn't valid JSON, or fields are missing
- **What the app does:** Every answer is checked against a schema. A broken one is asked again with the error explained, then once on the stronger model; a cut-off answer is split in half, and a product missing from the answer is asked for alone. If the batch still fails after 3 more tries from the queue, its rows are marked Failed with the reason, and "Try failed ones again" on the import queues them again
- **Status:** Handled
- **Tested by:** `build.test.ts`, `retry.test.ts`

### AI call times out or provider is down
- **What happens:** The AI request hangs or the provider keeps returning errors
- **What the app does:** Every call has a 90 s timeout. Timeouts, overloaded or 5xx errors and network errors are tried again by the queue after about 10, 20 and 40 s, and an empty account pauses every import and carries on by itself after a top-up. A provider that stays down longer than that marks the batch's rows Failed, with the retry button
- **Status:** Partly handled: a long outage fails rows instead of pausing the import
- **Tested by:** `anthropic.test.ts`, `build.test.ts`, `retry.test.ts`, real run (10,000 rows: a Claude slowdown with timeouts, 43 AI hiccups retried, nothing lost)

### Rate limit hit
- **What happens:** The provider returns "too many requests" (429)
- **What the app does:** Calls are spaced out to stay under `AI_REQUESTS_PER_MINUTE` (60 by default), shared by all workers through the database. A 429 pauses every worker until its Retry-After (30 s if none). A pause over 90 s puts the batch back in the queue for when it ends, without using up a try, and the import shows "Paused" with "resuming in X minutes"
- **Status:** Handled (tested with real Claude)
- **Tested by:** `rate-limit.test.ts`, `anthropic.test.ts`, `build.test.ts`, real run (10,000 rows: a few rate-limit pauses, all carried on)

### AI gives a wrong answer
- **What happens:** The JSON is valid but the content is wrong, like a planter put in "Kitchen"
- **What the app does:** Prices, SKUs, sizes, weights and colours come from code and the AI can't set them; its own doubts about prices or SKUs are dropped because code reports those with the exact rows. The category must be on the fixed list ("Other" goes to review), a field the AI scores under 70% goes to Needs review, and an attribute it's unsure of, or a measurement when the variants have sizes, is left out
- **Status:** Partly handled: a wrong category the AI is sure about isn't caught by code, only by the merchant before approving
- **Tested by:** `verify.test.ts`

### AI leaves a translation in English
- **What happens:** The AI sends back text it didn't translate. Claude once returned "Audit Bud Vase" as the French title
- **What the app does:** A description that's the same as the English, a sentence copied from it, or a title of two or more words that's the same as the English counts as a problem. The product gets one more try on the stronger model with the problem spelled out; if it's still English, shoppers see the English and the merchant sees the reason. A one-word title can be the same in both languages ("Vase"), and a title that's only a brand name can be saved by the merchant as their own translation
- **Status:** Handled
- **Tested by:** `checks.test.ts`, `translations.test.ts`, real run (1 of 31,399 translated titles came back in English before the title check; translated again: "Vase à bourgeon Audit")

## Scale

### 10,000-row import
- **What happens:** A merchant uploads 10,000 rows and 2,000 photos
- **What the app does:** The upload returns right away. A background worker reads the sheet and sends products to the AI 10 per call, the dashboard shows live progress, and the shop keeps serving because it only reads Postgres. The limits are 10,000 rows, 25 MB and 2,000 photos per import; a bigger sheet fails at once with "The sheet has 10,001 rows. The limit is 10,000 per import. Split it into smaller files" and nothing is saved
- **Status:** Handled (tested with real Claude)
- **Tested by:** real run (10,000 rows: 7,054 Done, 2,946 Needs review, 0 Failed, 6,302 products, finished with translations in 20 min 22 s, $2.34; the shop page's p99 was 308 ms and a product page's 505 ms during it, 0 errors; 10,001 rows refused in about 1 s, 0 AI calls). No real run with 2,000 photos yet

### Same file uploaded twice
- **What happens:** The merchant uploads the same sheet again
- **What the app does:** Products whose rows haven't changed skip the AI. Changed rows update the same product, and if only prices changed, the prices are updated without an AI call. After an instruction change the listings are written again, and uploading the file while its first import still runs returns that import
- **Status:** Handled (tested with real Claude)
- **Tested by:** `build.test.ts`, `create-import.test.ts`, `queries.test.ts`, real run (same sheet again: 0 paid AI calls)

### Same SKU from a different file
- **What happens:** A Shopify export, then later a supplier sheet in another layout, both have SKU `TC-PL-20`
- **What the app does:** The product is found by its SKU and updated, not duplicated. A file with no new text (a price list) only updates prices, with no AI call, and a very different name or SKUs spread over two products go to Needs review. The import card says "6 products: 4 new, 2 already in your catalog from shopify_products_export.csv (updated)"
- **Status:** Handled
- **Tested by:** `build.test.ts`, `queries.test.ts`, `dashboard.test.ts`

### Two imports running at the same time
- **What happens:** Two imports start at once
- **What the app does:** Both run, and each shows its own progress. The same file uploaded twice at once becomes one import. AI batches are taken first come, first served, so a small import started after a big one waits behind the big one's batches
- **Status:** Partly handled: no fair sharing between imports yet
- **Tested by:** `create-import.test.ts` (5 uploads of the same file at once give one import). Nothing tests two different imports at once

### Server restarts in the middle of an import
- **What happens:** The server restarts halfway through a 10,000-row import
- **What the app does:** Rows, products, AI answers and the job queue are all in Postgres, and the import remembers its stage. A dead worker's jobs stop sending heartbeats and are picked up again within about 30 s, and saved AI answers are reused, so nothing is lost or saved twice. Only AI calls cut off mid-answer are paid again
- **Status:** Handled (tested with real Claude)
- **Tested by:** `run-parse-import.test.ts`, `build.test.ts`, `watchdog.test.ts`, real run (5,000 rows, worker killed with `kill -9` at 32%, started again 14 s later: all 5,000 rows final, 0 duplicate products, SKUs or translations, 373 batches with exactly 373 successful AI calls, about 12 calls paid twice (about a cent); the dashboard and shop kept working while the worker was down)

## Later changes

### Merchant edits a product, then re-uploads the sheet
- **What happens:** The merchant fixes a title by hand, then uploads the sheet again
- **What the app does:** Fields the merchant edited and prices they typed are never overwritten; the AI still updates the other fields. On an approved product the new listing waits as "Update waiting" (next case)
- **Status:** Partly handled: if the new sheet changes text the merchant edited, their version is kept but they aren't told the sheet changed
- **Tested by:** `products.test.ts`, `build.test.ts`

### AI rewrites an approved product
- **What happens:** The sheet's text or the AI's instructions change, and the AI writes a new listing for a product that's already in the shop
- **What the app does:** The approved listing stays in the shop. The new one waits on the product page as "Update waiting" with "Use the new version" or "Keep the current one", while new prices and variants are saved at once. If the new version reads the same, nothing waits, and a kept listing isn't offered again by the same sheet
- **Status:** Handled
- **Tested by:** `build.test.ts`, `products.test.ts`

### Supplier changes a price the merchant typed
- **What happens:** The merchant typed €32.00 for CW-15, then a new sheet says €34.00
- **What the app does:** The typed price stays. The product shows "SKU CW-15: the supplier's sheet now says €34.00 (you set €32.00)", once per new sheet price. An approved product stays in the shop; one that wasn't approved yet goes to Needs review
- **Status:** Handled
- **Tested by:** `products.test.ts`, `build.test.ts`

### Merchant deletes a product
- **What happens:** The merchant deletes a product from the dashboard
- **What the app does:** It disappears from the storefront and exports right away and stays in the database marked as deleted. A later upload with its SKUs, even in another layout, skips it with "Skipped: you deleted this product. Restore it to import it again"
- **Status:** Handled
- **Tested by:** `products.test.ts`, `build.test.ts`, `export.test.ts`, `storefront.test.ts`

### Merchant fixes a translation, then the English text changes
- **What happens:** The merchant corrects the German title, and later the English title changes
- **What the app does:** The merchant's German is kept, never redone by the AI, and marked "Out of date"; they can confirm it or go back to the AI's. Everything else is translated again only for the fields whose English changed
- **Status:** Handled
- **Tested by:** `translations.test.ts`, `localize.test.ts`

## Storefront

### Product still waiting for review
- **What happens:** A product is in Needs review
- **What the app does:** The shop only shows approved products that aren't deleted. Approving is refused while a variant has no price, and approving several at once asks before approving ones that need review. An approved product with a new version waiting keeps showing the approved one
- **Status:** Handled
- **Tested by:** `storefront.test.ts`, `products.test.ts`

### Translation missing
- **What happens:** A German visitor opens a product that isn't translated yet
- **What the app does:** Each field shows the merchant's translation, else the AI's if it was made from the current English and passed every check, else the English. Pages only read Postgres; the AI is never called while the shopper waits
- **Status:** Handled
- **Tested by:** `localize.test.ts`, `storefront.test.ts`

### Visitor from a country with no translation
- **What happens:** A visitor from a country with no translation, like Spain
- **What the app does:** The country comes from the switcher (`?country=` or its cookie), then the hosting platform's IP country header. Germany and Austria get German and France gets French; Switzerland, Liechtenstein, Belgium, Luxembourg and Monaco can be switched on in Languages. Everyone else gets English
- **Status:** Handled
- **Tested by:** `storefront.test.ts`
