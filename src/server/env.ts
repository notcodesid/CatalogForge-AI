import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is not set. Copy .env.example to .env.local"),
  // Neon on Vercel sets both: DATABASE_URL goes through Neon's pooler, which refuses the queue's (pg-boss)
  // connection settings and drops our timeouts, and DATABASE_URL_UNPOOLED connects directly. The direct one wins
  DATABASE_URL_UNPOOLED: z.string().optional(),
  // Where uploaded files go: a local folder (STORAGE_DIR), the database itself ("database", for a demo deployment
  // where the web app and the worker share only the database), or a bucket (set S3_BUCKET below)
  FILE_STORAGE: z.enum(["folder", "database"]).default("folder"),
  // Folder for uploaded files while running locally
  STORAGE_DIR: z.string().min(1).default("storage"),
  // An S3-compatible bucket for uploaded files instead (Cloudflare R2), for when the web app and the worker run on
  // different machines. R2's endpoint is https://<account id>.r2.cloudflarestorage.com and its region "auto"
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // Which AI writes the products: Claude (the main one), DeepSeek, or "mock" which works offline and costs nothing
  // (tests, demo mode)
  AI_PROVIDER: z.enum(["mock", "anthropic", "deepseek"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com"),
  // Cheap model for clean products, stronger one for messy ones (other languages, conflicts, missing names)
  ANTHROPIC_MODEL_CHEAP: z.string().default("claude-haiku-5-5"),
  ANTHROPIC_MODEL_STRONG: z.string().default("claude-sonnet-5-5"),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().default("https://api.deepseek.com"),
  // Cheap model for clean products, stronger one for messy ones (other languages, conflicts, missing names)
  DEEPSEEK_MODEL_CHEAP: z.string().default("deepseek-flash"),
  DEEPSEEK_MODEL_STRONG: z.string().default("deepseek-v4-pro"),
  // The provider's limit. Calls are spaced out to stay under it. Claude's depends on the account (the console's
  // Limits page); DeepSeek publishes no fixed limit, but it answers "too many requests" when overloaded
  AI_REQUESTS_PER_MINUTE: z.coerce.number().min(1).max(10_000).default(60),
  // How many AI batches one worker runs at the same time
  AI_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  // How many translation batches it runs at the same time, next to those. Translating is most of the AI work (two
  // languages for every product), so it can use more. Unset: the same as AI_CONCURRENCY
  AI_TRANSLATE_CONCURRENCY: z.coerce.number().int().min(1).max(40).optional(),
  // Set on a host with no always-on machine (Vercel's free plan): the worker then runs in bursts inside a web
  // function (worker/serverless.ts), and this key guards the route that starts them. Unset: run `pnpm worker`
  WORKER_KEY: z.string().min(16).optional(),
}).superRefine((e, ctx) => {
  if (!e.S3_BUCKET) return;
  for (const key of ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
    if (!e[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is not set. It's needed with S3_BUCKET` });
  }
}).transform((e) => ({ ...e, DATABASE_URL: e.DATABASE_URL_UNPOOLED || e.DATABASE_URL }));

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

// Read on first use, not at import time, so `next build` works without a database URL
export function env(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
