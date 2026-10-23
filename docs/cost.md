# Cost

[Back to the README](../README.md)

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

Every AI call is recorded with its tokens, time and cost at the provider's published prices (`ai_calls`,
`src/server/ai/pricing.ts`), including Claude's prompt cache (writing it costs a little more than normal input,
reading it far less) and DeepSeek's cheaper repeated input and peak/off-peak prices.

Measured with real Claude:

| Run | Products | Writing | Translating (German + French) | Total | Per 1,000 products |
|---|---|---|---|---|---|
| 10,000 rows | 6,302 | $0.85 | $1.49 | $2.34 | $0.37 |
| 5,000 rows, worker killed at 32% | 3,725 | $0.49 | $0.85 | $1.34 | $0.36 |

Rebuilding 5,000 rows from the saved AI answers after changing only our checks took 1 min 27 s and cost $0 for
writing (translating the fields that changed: about $0.46). Total AI spend for a full day of testing with
Claude: $5.52. The Metrics tab shows the live figures, and what routing, batching and the answer cache saved.
