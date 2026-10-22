import { costMicroUsd } from "@/server/ai/pricing";
import { BUILD_INSTRUCTIONS_CHARS, TRANSLATE_INSTRUCTIONS_CHARS } from "./instructions";

// Money our design saved, estimated from the AI calls we recorded. These are estimates, not invoices: they price
// calls that never happened. Each is worked out from sums of calls in the same hour (peak and off-peak prices
// differ by the hour), which gives the same result as call by call because every price is linear in the tokens

export type CallSums = {
  // Start of the hour the calls were made in
  hour: Date;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  products: number;
};

// We don't store how much of a call's input the provider served from its cache (billed at a fraction of the price),
// but the cost depends on it in a straight line, so it can be worked back out: 0 = no cached input, 1 = all of it.
// Claude's cache writes (billed a little above the normal price, once per 5 minutes of calls) make it come out a
// little low, and the savings below a little high
export function cachedShare(sums: Pick<CallSums, "hour" | "model" | "inputTokens" | "outputTokens" | "costMicroUsd">): number {
  const usage = { inputTokens: sums.inputTokens, outputTokens: sums.outputTokens };
  const full = costMicroUsd(sums.model, { ...usage, cachedInputTokens: 0 }, sums.hour);
  const allCached = costMicroUsd(sums.model, { ...usage, cachedInputTokens: sums.inputTokens }, sums.hour);
  if (full <= allCached) return 0;
  return Math.min(1, Math.max(0, (full - sums.costMicroUsd) / (full - allCached)));
}

// Routing: clean products go to the cheap model. Had these calls gone to the strong model instead, with the same
// tokens, the same share of cached input and at the same hour, they would have cost this much more
export function routingSavingMicroUsd(sums: CallSums, strongModel: string): number {
  const share = cachedShare(sums);
  const usage = { inputTokens: sums.inputTokens, outputTokens: sums.outputTokens };
  const full = costMicroUsd(strongModel, { ...usage, cachedInputTokens: 0 }, sums.hour);
  const allCached = costMicroUsd(strongModel, { ...usage, cachedInputTokens: sums.inputTokens }, sums.hour);
  return Math.max(0, full - share * (full - allCached) - sums.costMicroUsd);
}

// Rough tokens for a text: about 4 characters per token for English and JSON
const tokensOf = (chars: number) => Math.ceil(chars / 4);

// What's sent with every call whatever the batch holds: the instructions, the answer's shape, and for the AI step
// the list of categories
export function instructionTokens(purpose: string): number {
  return tokensOf(purpose === "translate" ? TRANSLATE_INSTRUCTIONS_CHARS : BUILD_INSTRUCTIONS_CHARS);
}

// Batching: one call carries 10 products, so the instructions are sent once instead of 10 times. One call per
// product would have sent them (products - calls) more times, priced like the input of our real calls (with the
// share the provider served from its cache)
export function batchingSavingMicroUsd(sums: CallSums, purpose: string): { microUsd: number; extraTokens: number } {
  const extraTokens = instructionTokens(purpose) * Math.max(0, sums.products - sums.calls);
  if (!extraTokens || !sums.inputTokens) return { microUsd: 0, extraTokens };
  const cached = Math.round(cachedShare(sums) * extraTokens);
  return { microUsd: costMicroUsd(sums.model, { inputTokens: extraTokens, outputTokens: 0, cachedInputTokens: cached }, sums.hour), extraTokens };
}

// Saved answers: a retry after a crash, or the same question again, is answered from ai_cache for free. Each such
// call is priced like a real one of the same model and kind: its products x what a product costs there
export function cacheSavingMicroUsd(cachedProducts: number, reference: { costMicroUsd: number; products: number } | undefined): number {
  if (!reference?.products) return 0;
  return cachedProducts * (reference.costMicroUsd / reference.products);
}
