import {
  AiOutOfCreditError,
  AiPermanentError,
  AiRateLimitError,
  AiTemporaryError,
  instructionsWithShape,
  type AiProvider,
  type AiRequest,
  type AiResult,
  type AiTier,
} from "./provider";

type ClaudeResponse = {
  content?: { type: string; text?: string }[];
  stop_reason?: string | null;
  usage?: {
    // Input after the cached part, billed at the normal price
    input_tokens?: number;
    // Input stored for the next calls (our instructions), billed a little above the normal price
    cache_creation_input_tokens?: number | null;
    // Input read back from the cache, billed at a tenth or less
    cache_read_input_tokens?: number | null;
    output_tokens?: number;
  };
  error?: { type?: string; message?: string; details?: { error_code?: string } | null };
};

export type AnthropicOptions = {
  apiKey: string;
  baseUrl: string;
  models: Record<AiTier, string>;
  requestsPerMinute: number;
};

// Thinking off: it costs paid output tokens and time, and our own checks do the careful part. Each model has its
// own switch (tried against the live API, October 2026): Haiku 5.5 takes "disabled", Sonnet 5.5 refuses that and
// takes "between_tools" (no thinking before the answer), Opus 5.5 only lets thinking be turned down
export function thinkingOff(model: string): Record<string, unknown> {
  if (model.startsWith("claude-sonnet-5-5")) return { thinking: { type: "between_tools" } };
  if (model.startsWith("claude-opus-5-5")) return { output_config: { effort: "low" } };
  return { thinking: { type: "disabled" } };
}

function toError(status: number, body: ClaudeResponse, retryAfter: string | null): Error {
  const message = body.error?.message ?? `HTTP ${status}`;
  // No prepaid credit left (400 "credit balance is too low"), or the monthly spend limit the organization set
  // (a 429 that waiting won't fix): everything waits until someone tops up (see ask.ts)
  if (status === 402 || body.error?.details?.error_code === "enforced_spend_limit_reached" || /credit balance|usage limits/i.test(message)) {
    return new AiOutOfCreditError(`Claude: the account is out of credit (${message})`);
  }
  if (status === 429) {
    const seconds = retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;
    return new AiRateLimitError(`Claude rate limit: ${message}`, Number.isFinite(seconds) ? seconds * 1000 : 30_000);
  }
  // Overloaded (529) or down: worth another try later
  if (status >= 500 || status === 408) return new AiTemporaryError(`Claude ${status}: ${message}`);
  // 401 bad key, 403 not allowed, 404 unknown model, 400 bad request: trying again won't help
  return new AiPermanentError(`Claude ${status}: ${message}`);
}

// In case the answer comes wrapped in a ```json block: the JSON inside is the answer
function withoutFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : text.trim();
}

// Claude's Messages API. Our instructions are the same on every call, so they're marked for caching: stored once,
// then read back at a tenth of the price or less while calls keep coming (the cache lasts 5 minutes)
export function createAnthropicProvider(options: AnthropicOptions): AiProvider {
  return {
    name: "anthropic",
    requestsPerMinute: options.requestsPerMinute,
    modelFor: (tier) => options.models[tier],

    async generate(request: AiRequest): Promise<AiResult> {
      const model = options.models[request.tier];
      const body = {
        model,
        max_tokens: request.maxOutputTokens,
        system: [{ type: "text", text: instructionsWithShape(request.system, request.jsonSchema), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: JSON.stringify(request.input) }],
        ...thinkingOff(model),
      };

      let res: Response;
      try {
        res = await fetch(`${options.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw err;
        throw new AiTemporaryError(`Couldn't reach Claude: ${err instanceof Error ? err.message : String(err)}`);
      }

      let json: ClaudeResponse;
      try {
        json = (await res.json()) as ClaudeResponse;
      } catch {
        throw res.ok ? new AiTemporaryError("Claude sent an answer that isn't JSON") : toError(res.status, {}, res.headers.get("retry-after"));
      }
      if (!res.ok) throw toError(res.status, json, res.headers.get("retry-after"));
      if (json.stop_reason === "refusal") throw new AiPermanentError("Claude declined to answer");

      const text = (json.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      const usage = json.usage ?? {};
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      return {
        text: withoutFence(text),
        model,
        // Claude counts cached input apart from the rest; inputTokens is all of it
        inputTokens: (usage.input_tokens ?? 0) + cacheRead + cacheWrite,
        cachedInputTokens: cacheRead,
        cacheWriteInputTokens: cacheWrite,
        outputTokens: usage.output_tokens ?? 0,
        truncated: json.stop_reason === "max_tokens" || json.stop_reason === "model_context_window_exceeded",
      };
    },
  };
}
