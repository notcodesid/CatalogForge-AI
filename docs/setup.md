# Setup

[Back to the README](../README.md)

Needs Node 22.12+, pnpm and Docker.

```bash
pnpm install
cp .env.example .env.local
pnpm db:up          # Postgres in Docker, on port 5433
pnpm db:migrate     # create the tables
```

`.env.example` starts with the mock AI (offline, free). For Claude, set `AI_PROVIDER=anthropic` and
`ANTHROPIC_API_KEY` in `.env.local` (see [AI options](#ai-options) and [Speed settings](#speed-settings)).

Then, in two terminals:

```bash
pnpm dev            # API + web app on http://localhost:3000
pnpm worker         # background worker that processes the queue
```

Check everything is connected:

```bash
curl http://localhost:3000/api/health   # database, queue, and how many workers are online
pnpm queue:ping                         # sends a test job and waits for the worker to finish it
```

Import a sheet (with `pnpm dev` and `pnpm worker` running):

```bash
pnpm import:file samples/catalogforge_test_sheet.csv    # uploads it, waits, prints what happened to every row
pnpm import:file samples/catalogforge_test_sheet.csv --photos samples/test-files/09-photos/photos   # with photos
pnpm import:file samples/test-files/09-photos/photo_links.csv    # photos from links: real ones, broken ones, unsafe ones
```

## AI options

Set with `AI_PROVIDER` in `.env.local`:

- `anthropic` (Claude, the main one): clean products go to `claude-haiku-5-5`, messy ones to the stronger
  `claude-sonnet-5-5` (`ANTHROPIC_MODEL_CHEAP` / `ANTHROPIC_MODEL_STRONG` to change them). Thinking is turned off
  (it costs output tokens and time; our checks do the careful part). The instructions are marked for Claude's
  prompt cache. Answers are JSON: the shape is in the instructions and zod checks every answer (Claude's strict
  JSON mode can't describe maps with free keys, like attributes and confidence). Rate limits, an empty account or a
  spending limit pause the import (see [Scale and reliability](scale-and-reliability.md)). Needs `ANTHROPIC_API_KEY`.
- `deepseek`: the same with `deepseek-flash` and `deepseek-v4-pro`. Needs `DEEPSEEK_API_KEY`.
- `mock`: works offline and costs nothing (tests, demo mode, large speed tests). `MOCK_AI_MODE` makes it misbehave
  on purpose (invent claims, fail, hit the rate limit, run out of credit, cut off its answer, send broken JSON, skip
  translating) to show the checks catch it.

## Speed settings

`AI_REQUESTS_PER_MINUTE` (all workers together, default 60), `AI_CONCURRENCY` (batches written at once per
worker, default 2) and `AI_TRANSLATE_CONCURRENCY` (batches translated at once, next to those; defaults to
`AI_CONCURRENCY`). For Claude we use 300 / 10 / 12: about 80% of our account's 400,000 output tokens a minute.
At 10 and 16 we hit the limit a few times, and the app paused and carried on by itself.

## Scripts

| Script | What it does |
|---|---|
| `pnpm db:up` / `pnpm db:down` | Start / stop Postgres in Docker |
| `pnpm db:generate` | Create a migration after changing `src/server/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:studio` | Browse the database in the browser |
| `pnpm worker` | Run the background worker (`worker:dev` restarts on file changes) |
| `pnpm worker:demo-pause` | A worker with the mock AI whose first call hits a 2-minute rate limit: the import shows "Paused" and carries on by itself. Start it instead of `pnpm worker`, and upload a sheet with new products (unchanged ones skip the AI) |
| `pnpm worker:demo-fail` | A worker with the mock AI whose first 4 calls fail: a small sheet's rows end up Failed after their retries, and "Try failed ones again" then works. Same rules as above |
| `pnpm build` / `pnpm start` | Production build of the web app / serve it (used for the storefront speed numbers) |
| `pnpm queue:ping` | Send a test job and wait for the worker to finish it |
| `pnpm import:file <file> [--photos <folder or zip>]` | Upload a sheet (and photos) through the API and print the result for every row and photo |
| `pnpm reset:data --yes` | Empty the app (imports, products, translations, photos, AI calls, uploaded files) before a demo or deploy. Keeps the language settings, refuses while an import runs |
| `pnpm test` | Run tests against a separate test database |
| `pnpm typecheck` / `pnpm lint` | Type check / lint |

## Deploying to AWS

The scalable setup runs on AWS: the web app and the workers as containers (ECS Fargate), a private RDS Postgres, S3
for files, CloudFront for HTTPS, and workers that scale on the queue backlog. One command builds and deploys it:
`AWS_PROFILE=<profile> infra/aws/deploy.sh`. Details and measured results: [infra/aws/README.md](../infra/aws/README.md).

## Live deployment

A second copy runs on free plans, with no card needed:

| Part | Where |
|---|---|
| Web app (dashboard, shop, API) | Vercel, region `fra1` (`vercel.json`), deployed with `vercel deploy --prod` |
| Database | Neon Postgres in Frankfurt, added through Vercel's Neon integration |
| Uploaded files | The same database (`FILE_STORAGE=database`, table `stored_files`): Vercel and the worker share nothing else |
| Worker | Runs in bursts inside a Vercel function (`/api/worker`, `src/worker/serverless.ts`), switched on by `WORKER_KEY` |

What the free setup changes:

- **Uploads are capped at 4 MB per request** (`NEXT_PUBLIC_MAX_REQUEST_MB=4`), because Vercel refuses bigger
  requests. The browser sends photos in smaller batches and says which files are too big.
- **The app connects to Neon directly** (`DATABASE_URL_UNPOOLED`). Neon's pooler refuses the queue's connection
  settings.
- **The worker runs in bursts.** There's no always-on machine on a free plan, so anything that queues work (an
  upload, a retry, an edit to translate) starts a burst: the normal worker, in a function, for about 3 minutes. It
  stops early when there's nothing left, and starts the next burst when there is. A burst cut off by the function's
  300-second limit is like a worker crash, and the next one picks its jobs up again. The dashboard also starts one
  when it sees work waiting with no worker online. Nothing runs while there's no work, so Neon can sleep.
- **A laptop can help:** `pnpm worker:live` runs the always-on worker against the live database (`.env.deploy`,
  git-ignored, with `DATABASE_URL` set to Neon's direct URL and `FILE_STORAGE=database`).
- **Files in the database are for a demo.** For real use, set `S3_BUCKET` (Cloudflare R2 or S3) instead.

Settings on Vercel: `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (set by the Neon integration), `FILE_STORAGE=database`,
`NEXT_PUBLIC_MAX_REQUEST_MB=4`, `WORKER_KEY` (any random string), and the AI settings (`AI_PROVIDER`,
`ANTHROPIC_API_KEY`, `AI_REQUESTS_PER_MINUTE`, `AI_CONCURRENCY`, `AI_TRANSLATE_CONCURRENCY`). Migrations run from a
laptop against the direct URL: `DATABASE_URL=<direct url> pnpm db:migrate`.

### Scaling past the free setup

The free setup is for the demo. What limits it, and what replaces it for real use (the AWS setup above does all of
it except the signed uploads, which it doesn't need: it has no 4 MB limit):

| Free setup | Its limit | For real scale |
|---|---|---|
| Worker in bursts inside a Vercel function | Each burst lasts about 4 minutes and starts cold (10 to 20 s); at most 2 run at once | Always-on workers, in containers or on small servers. More workers means more speed: they already share the queue and the AI rate limit safely |
| Files in the database | Neon's free plan has 0.5 GB, and every photo is read through the database | A bucket: set `S3_BUCKET` (Cloudflare R2 or Amazon S3), already supported |
| Uploads through Vercel | 4 MB per request | Uploads straight from the browser to the bucket with signed links (not built yet) |
| Neon's free plan | 100 hours of compute a month, and an always-on worker keeps the database awake | A paid Postgres plan |

The import pipeline is the same code in every setup: the queue, retries, crash recovery and duplicate protection
don't change. The 10,000-row run and the crash test in the README used an always-on worker on one machine. With
more workers, the AI provider's limits become the ceiling (see [what breaks first](write-up.md)).
