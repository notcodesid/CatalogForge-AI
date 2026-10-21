import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is not set. Copy .env.example to .env.local"),
  // Folder for uploaded files while running locally
  STORAGE_DIR: z.string().min(1).default("storage"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

// Read on first use, not at import time, so `next build` works without a database URL
export function env(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
