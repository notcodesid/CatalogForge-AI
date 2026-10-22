import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { aiCalls } from "@/server/db/schema";
import { testDatabaseUrl } from "@/test/global-setup";
import { askAi } from "./ask";
import { mockProvider, resetMockState } from "./mock";
import { buildInput, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";
import type { AiProvider } from "./provider";
import { buildResponseJsonSchema, buildResponseSchema } from "./schema";

const db = createDb(testDatabaseUrl());
let calls = 0;
const provider: AiProvider = { ...mockProvider, generate: (r) => (calls++, mockProvider.generate(r)) };

beforeEach(async () => {
  await db.execute(sql`truncate ai_cache, ai_calls, ai_status restart identity cascade`);
  resetMockState();
  calls = 0;
});

afterAll(async () => {
  await db.$client.end();
});

describe("askAi", () => {
  const request = (feedback?: string) => ({
    purpose: "build" as const,
    tier: "cheap" as const,
    promptVersion: PROMPT_VERSION,
    system: SYSTEM_PROMPT,
    input: buildInput([{ key: "sku:a-1", language: "en", variants: [], sourceRows: [{ row: 2, cells: { Name: "Blue Vase" } }] }]),
    schema: buildResponseSchema,
    jsonSchema: buildResponseJsonSchema,
    productCount: 1,
    feedback,
  });

  it("answers the same question from the saved answer, but asks again when there's feedback on that answer", async () => {
    const ctx = { db, provider, importId: null };
    expect((await askAi(ctx, request())).ok).toBe(true);
    expect((await askAi(ctx, request())).ok).toBe(true);
    expect(calls).toBe(1);
    // "Your previous answer copied the German text": the same answer from the cache would be no use
    expect((await askAi(ctx, request("Your previous answer copied the supplier's German text."))).ok).toBe(true);
    expect(calls).toBe(2);
    expect((await db.select().from(aiCalls)).map((c) => c.fromCache)).toEqual([false, true, false]);
  });
});
