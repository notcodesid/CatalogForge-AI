# Edge Cases

## Messy input

### File is broken, empty, or in the wrong format
- **What happens:** The upload is a corrupt file, an empty file, or not really a CSV/XLSX (like a PDF renamed to .csv)
- **What the app does:** Check the real file type and size before accepting it. If it can't be read, the import fails with a clear message and no products are created
- **Status:** Not handled yet

### Prices in different formats, or missing
- **What happens:** Prices like `1.299,00 €`, `12.5`, `£8`, or empty
- **What the app does:** Code (not the AI) converts every price to integer cents + a currency code. If a price is missing or can't be read, the product goes to Needs review. We never guess a price
- **Status:** Not handled yet

### Same SKU appears twice with different data
- **What happens:** SKU `TC-PL-20` is on two rows with different prices
- **What the app does:** Identical rows are merged. If the rows disagree, the product goes to Needs review showing both values
- **Status:** Not handled yet

### Required fields missing (title, price)
- **What happens:** A row has no title or no price
- **What the app does:** No title: the AI can suggest one, but the product goes to Needs review. No price: Needs review, never made up
- **Status:** Not handled yet

### Mixed units (cm/inch, kg/lbs)
- **What happens:** Sizes in cm and inches, weights in kg and lbs, in the same sheet
- **What the app does:** Code converts everything to cm and grams. If a value has no unit, use the unit from the column header. If that's missing too, Needs review
- **Status:** Not handled yet

### Description has HTML or script tags
- **What happens:** Supplier descriptions include `<script>` tags, `onclick=` and other unsafe HTML
- **What the app does:** Remove everything except basic formatting tags (`p`, `ul`, `li`, `strong`…) before saving or showing it. The AI's output gets cleaned the same way
- **Status:** Not handled yet

### Very long descriptions
- **What happens:** A description is thousands of words long
- **What the app does:** Keep the full text, but only send a capped length to the AI. If it was cut, flag the product for review
- **Status:** Not handled yet

### Photos that don’t match any row
- **What happens:** Photos like `IMG_4532.jpg` that don't match any SKU in the sheet
- **What the app does:** Match photos to products by filename (SKU). Unmatched photos are listed on the import so the merchant can assign them by hand. They don't stop the import
- **Status:** Not handled yet

## AI problems

### AI adds a claim that isn’t in the source
- **What happens:** The AI writes "organic" or "dishwasher-safe" when the supplier never said that
- **What the app does:** The AI must give the exact source text for every claim. Code checks that text is really in the sheet. If it isn't, the claim is removed and the product goes to Needs review
- **Status:** Not handled yet

### AI returns broken JSON
- **What happens:** The AI's response isn't valid JSON, or fields are missing
- **What the app does:** Validate every response against a schema. If it's invalid, retry (up to 3 times). If it still fails, mark the rows Failed with the reason and a retry button
- **Status:** Not handled yet

### AI call times out or provider is down
- **What happens:** The AI request hangs or the provider keeps returning errors
- **What the app does:** Every call has a timeout and is retried with exponential backoff. If the provider stays down, pause the import instead of failing every row
- **Status:** Not handled yet

### Rate limit hit
- **What happens:** The provider returns "too many requests" (429)
- **What the app does:** Pause the queue until the limit resets, show "Paused — resuming in X minutes", then continue automatically
- **Status:** Not handled yet

### AI gives a wrong answer
- **What happens:** The JSON is valid but the content is wrong, like a planter put in "Kitchen"
- **What the app does:** Prices, SKUs and weights come from code, not the AI. Category must come from a fixed list. Fields with low confidence go to Needs review
- **Status:** Not handled yet

## Scale

### 10,000-row import
- **What happens:** A merchant uploads 10,000 rows and 2,000 photos
- **What the app does:** The upload returns right away and the work runs in a background queue, in batches. Progress shows live on the dashboard
- **Status:** Not handled yet

### Same file uploaded twice
- **What happens:** The merchant uploads the same sheet again
- **What the app does:** Unchanged rows are skipped, changed rows update the existing product. No duplicates
- **Status:** Not handled yet

### Two imports running at the same time
- **What happens:** Two imports start at once
- **What the app does:** Both share the workers fairly, so a small import isn't stuck behind a big one. Each import shows its own progress
- **Status:** Not handled yet

### Server restarts in the middle of an import
- **What happens:** The server restarts halfway through a 10,000-row import
- **What the app does:** Every row's progress is saved in the database. After the restart, the import continues from where it stopped. Nothing lost, nothing done twice
- **Status:** Not handled yet

## Later changes

### Merchant edits a product, then re-uploads the sheet
- **What happens:** The merchant fixes a title by hand, then uploads the sheet again
- **What the app does:** The merchant's edit is kept. If the new sheet changed that product, it gets flagged so the merchant can check it
- **Status:** Not handled yet

### Merchant deletes a product
- **What happens:** The merchant deletes a product from the dashboard
- **What the app does:** It disappears from the storefront and exports right away. It stays in the database marked as deleted, so a re-upload doesn't silently bring it back
- **Status:** Not handled yet

### Merchant fixes a translation, then the English text changes
- **What happens:** The merchant corrects the German title, and later the English title changes
- **What the app does:** The merchant's German fix is kept and marked "Out of date" so they know to check it. Only the changed text is re-translated
- **Status:** Not handled yet

## Storefront

### Product still waiting for review
- **What happens:** A product is in Needs review
- **What the app does:** It isn't shown in the storefront until the merchant approves it
- **Status:** Not handled yet

### Translation missing
- **What happens:** A German visitor opens a product that isn't translated yet
- **What the app does:** Show the English text for anything missing. Never call the AI while the shopper waits
- **Status:** Not handled yet

### Visitor from a country with no translation
- **What happens:** A visitor from a country with no translation, like Spain
- **What the app does:** Show English. Germany and Austria get German, France gets French, everyone else gets English
- **Status:** Not handled yet
