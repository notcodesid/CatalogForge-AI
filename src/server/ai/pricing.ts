// What every AI call costs, in US dollars per 1 million tokens (the mock is free). Input the provider had already
// seen (our instructions, repeated on every call) is billed at the cheaper cached price. Claude also bills storing
// it for the next calls (a cache write), at a little more than the normal input price.
// Claude: https://platform.claude.com/docs/en/about-claude/pricing (October 2026). Haiku 5.5 costs 5x more for
// prompts over 100,000 tokens; ours are a few thousand.
// DeepSeek: https://api-docs.deepseek.com/quick_start/pricing (October 2026). Off-peak rates are half the peak rates
type Price = { input: number; cachedInput: number; cacheWrite?: number; output: number; peakDoubles?: boolean };

const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cachedInput: 0.01, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cachedInput: 0.1, output: 10 },
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cachedInput: 0.2, output: 20 },
  "deepseek-flash": { input: 0.15, cachedInput: 0.003, output: 0.6, peakDoubles: true },
  "deepseek-v4-pro": { input: 0.66, cachedInput: 0.022, output: 1.98, peakDoubles: true },
};

// DeepSeek's peak hours cost double: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday
function isPeak(at: Date) {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

// Cost in millionths of a dollar (an integer, so no rounding errors when costs are added up)
export function costMicroUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteInputTokens?: number },
  at: Date = new Date(),
): number {
  const price = PRICES[model];
  if (!price) return 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const written = Math.min(usage.cacheWriteInputTokens ?? 0, usage.inputTokens - cached);
  const dollarsPerMillion =
    (usage.inputTokens - cached - written) * price.input +
    cached * price.cachedInput +
    written * (price.cacheWrite ?? price.input) +
    usage.outputTokens * price.output;
  return Math.round(dollarsPerMillion * (price.peakDoubles && isPeak(at) ? 2 : 1));
}
