# Scale and reliability

[Back to the README](../README.md)

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
  slots are handed out from one row in Postgres). See [Speed settings](setup.md#speed-settings) for the values used with Claude.
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

The live demo runs on free plans, with the worker in short bursts inside a web function. Its limits, and what
replaces it at scale, are in [Setup: scaling past the free setup](setup.md#scaling-past-the-free-setup).
