import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is not set. Copy .env.example to .env.local"),
  // Folder for uploaded files while running locally
  STORAGE_DIR: z.string().min(1).default("storage"),
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
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

// Read on first use, not at import time, so `next build` works without a database URL
export function env(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
