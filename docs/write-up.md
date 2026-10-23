# Technical write-up

[Back to the README](../README.md)

**What was the hardest part?**

Making the AI's output safe to publish. Claude writes good listings, but now and then it adds something the
supplier never said: "handmade", "frost-proof" when the sheet says "not frost-proof", "organic" from "organic
cotton blend". Telling it not to in the prompt helped, but didn't stop it. So code now checks every claim against
the supplier's own words, in English, German and French, including the "not" in front of a claim and words like
"blend" that make it partial. The other half was false alarms: the first checks sent too much to review (64% of
the rows of the 10,000-row sheet). Tuning them on real sheets brought that down to 29%, and most of what's left are
problems planted in the test data on purpose.

The second hardest was making a crash at any moment safe. Every job is queued in the same database transaction as
the work it stands for, every step can run twice without harm, and a worker that dies mid-job is noticed by its
missing heartbeats. Killing the worker with `kill -9` in the middle of a 5,000-row import lost nothing and created no
duplicates.

**How did you make extraction accurate, and how did you stop invented claims?** See [Accuracy](accuracy.md).

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
  into German and French included. See [Cost](cost.md).

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
4. **Storage and search.** Photos belong in object storage: that's built (`S3_BUCKET`, for R2 or S3), while the
   free demo keeps them in the database. Every photo is still served through the web app; a CDN in front of the
   bucket should serve them instead. The product list needs keyset pagination and a search index (pg_trgm or
   full-text) instead of OFFSET and ILIKE.

**What did you learn?**

- **Let code do the facts and the AI do the words.** Prices, units, sizes and grouping are plain code with tests.
  The AI only writes text, and anything it says is checked. Every bug that came from the AI guessing a fact went
  away once the fact came from code instead.
- **Check the AI in code, not only in the prompt.** Prompt rules lower the mistakes; checks in code catch the rest.
  Checks also need real data to tune, or they flag too much.
- **Put the job queue in the database.** With jobs saved in the same transaction as the work, crash safety is
  simple to reason about: there's no moment where work is recorded but not queued.
- **Measure with the real AI.** With the instant mock AI, 10,000 rows took 33 seconds. With Claude it took 20
  minutes, limited by Claude's output-token limit, not by our code. More workers don't help there; a higher limit or
  the Batch API does.
- **Keep the edges small.** Storage and the worker sit behind small interfaces, so moving to free hosting (files in
  the database, the worker in short bursts on Vercel) took a few hours instead of a rewrite.

**How did you use AI while building this?**

- **Claude Code wrote most of the code, tests and docs.** I set the plan and the big decisions (Postgres as the
  queue, code for facts and AI for text, the hosting) and reviewed the results. I started with DeepSeek as the
  product's AI and switched to Claude, which only meant adding one provider behind the same interface.
- **I tested it as a merchant.** I uploaded real messy sheets and photos and checked what came out. A separate AI
  agent tested the app in the browser against the brief and reported what was broken. Each report went back to
  Claude Code as a fix with a test.
- **Real runs, not just the mock.** Every number in this write-up comes from real Claude runs, including the
  crash test.
- **Claude inside the product** writes the listings and translations: Haiku for clean products, Sonnet for messy
  ones, with code checking every answer.
