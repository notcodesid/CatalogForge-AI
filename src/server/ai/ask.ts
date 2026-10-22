import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/server/db/client";
import { aiCache, aiCalls } from "@/server/db/schema";
import { costMicroUsd } from "./pricing";
import { AiOutOfCreditError, AiRateLimitError, type AiProvider, type AiPurpose, type AiTier } from "./provider";
import { AiPausedError, pauseProvider, waitForTurn } from "./rate-limit";

const AI_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 8192;
// How often a paused import checks whether the AI account has been topped up
const CREDIT_RECHECK_MS = 2 * 60_000;
export const OUT_OF_CREDIT = "The AI account is out of credit. The import carries on by itself once it's topped up";

export type AskContext = { db: Db; provider: AiProvider; importId: string | null; signal?: AbortSignal };

export type AskRequest<T> = {
  purpose: AiPurpose;
  tier: AiTier;
  // Changes whenever the instructions change, so an answer saved for old instructions is never reused
  promptVersion: string;
  system: string;
  input: object;
  // The answer's shape: checked with zod, and sent to the AI as JSON Schema
  schema: z.ZodType<T>;
  jsonSchema: object;
  // For the cost per product
  productCount: number;
  // Added to the instructions when asking again after a rejected answer ("you copied the German text...")
  feedback?: string;
};

export type Answer<T> = { ok: true; data: T; model: string } | { ok: false; problem: "truncated" | "invalid"; error: string };

// One question to the AI, with everything around it: a saved answer is reused (a retry after a crash costs
// nothing), calls are spaced out to stay under the rate limit, "too many requests" pauses every worker, an empty
// account pauses the import, and every call is recorded with its tokens and cost. Only an answer in the right
// shape is saved; a cut-off or broken one is returned as a problem for the caller to handle
export async function askAi<T>(ctx: AskContext, request: AskRequest<T>): Promise<Answer<T>> {
  const { db, provider } = ctx;
  const model = provider.modelFor(request.tier);
  const record = (fields: Partial<typeof aiCalls.$inferInsert> & Pick<typeof aiCalls.$inferInsert, "status" | "latencyMs">) =>
    db.insert(aiCalls).values({ importId: ctx.importId, purpose: request.purpose, provider: provider.name, model, productCount: request.productCount, ...fields });

  // The same question asked before: reuse the saved answer, pay nothing. Asking again with feedback is a
  // different question, so it isn't answered from the first answer
  const keyParts = [provider.name, model, request.promptVersion, request.input, ...(request.feedback ? [request.feedback] : [])];
  const cacheKey = createHash("sha256").update(JSON.stringify(keyParts)).digest("hex");
  const [cached] = await db.select().from(aiCache).where(eq(aiCache.key, cacheKey)).limit(1);
  if (cached) {
    const reused = request.schema.safeParse(cached.response);
    if (reused.success) {
      await record({ status: "ok", latencyMs: 0, fromCache: true });
      return { ok: true, data: reused.data, model };
    }
  }

  let result;
  let started = Date.now();
  for (let rateLimited = 0; ; ) {
    // Wait for our turn (stays under the provider's limit, and respects a pause after "too many requests")
    await waitForTurn(db, provider.name, { requestsPerMinute: provider.requestsPerMinute, signal: ctx.signal });
    started = Date.now();
    try {
      const signals = [AbortSignal.timeout(AI_TIMEOUT_MS), ...(ctx.signal ? [ctx.signal] : [])];
      result = await provider.generate({
        purpose: request.purpose,
        tier: request.tier,
        system: request.feedback ? `${request.system}\n\n${request.feedback}` : request.system,
        input: request.input,
        jsonSchema: request.jsonSchema,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        signal: AbortSignal.any(signals),
      });
      break;
    } catch (err) {
      const timeout = err instanceof Error && err.name === "TimeoutError";
      const status = err instanceof AiRateLimitError ? "rate_limited" : timeout ? "timeout" : "error";
      await record({ status, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
      // "Too many requests": pause every worker, then wait our turn and ask again. Waiting isn't a failed try
      if (err instanceof AiRateLimitError && ++rateLimited <= 3) {
        await pauseProvider(db, provider.name, new Date(Date.now() + err.retryAfterMs), "The AI provider's rate limit was reached");
        continue;
      }
      // No credit left: every import pauses instead of failing its rows. One batch tries again every couple of
      // minutes (a refused call costs nothing), so after a top-up everything carries on by itself
      if (err instanceof AiOutOfCreditError) {
        const until = new Date(Date.now() + CREDIT_RECHECK_MS);
        await pauseProvider(db, provider.name, until, OUT_OF_CREDIT);
        throw new AiPausedError(until, OUT_OF_CREDIT);
      }
      throw err;
    }
  }

  const usage = {
    latencyMs: Date.now() - started,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costMicroUsd: costMicroUsd(model, result),
  };
  if (result.truncated) {
    await record({ status: "invalid_output", ...usage, error: "Answer cut off at the output limit" });
    return { ok: false, problem: "truncated", error: "cut off" };
  }

  let json: unknown;
  try {
    json = JSON.parse(result.text);
  } catch {
    await record({ status: "invalid_output", ...usage, error: "Not valid JSON" });
    return { ok: false, problem: "invalid", error: "it wasn't valid JSON" };
  }
  const parsed = request.schema.safeParse(json);
  if (!parsed.success) {
    const error = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    await record({ status: "invalid_output", ...usage, error });
    return { ok: false, problem: "invalid", error };
  }

  await db.insert(aiCache).values({ key: cacheKey, model, response: parsed.data as object }).onConflictDoNothing();
  await record({ status: "ok", ...usage });
  return { ok: true, data: parsed.data, model: result.model };
}
