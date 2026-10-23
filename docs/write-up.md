# Technical write-up

[Back to the README](../README.md)

(Draft.)

**What was the hardest part?** *(to write in your own words)* Candidates: making the AI's output trustworthy
(sentences it invents that no claim list catches, and claims whose strength changes across languages:
"frost-resistant" vs "frost-proof", "frostbeständig" vs "frostfest"), and making a crash at any moment safe
(attempt numbers, jobs queued in the same transaction as the work they stand for).

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
4. **Storage and search.** Photos on local disk move to object storage behind a CDN; the product list needs
   keyset pagination and a search index (pg_trgm or full-text) instead of OFFSET and ILIKE.

**What did you learn?** *(to write in your own words)*

**How did you use AI while building this?** *(to write in your own words)*
