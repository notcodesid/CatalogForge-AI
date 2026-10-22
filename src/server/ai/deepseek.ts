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

type DeepSeekResponse = {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    // Input the provider had already seen (our instructions repeat on every call): billed at a fraction
    prompt_cache_hit_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
};

export type DeepSeekOptions = {
  apiKey: string;
  baseUrl: string;
  models: Record<AiTier, string>;
  requestsPerMinute: number;
};

function toError(status: number, body: DeepSeekResponse, retryAfter: string | null): Error {
  const message = body.error?.message ?? `HTTP ${status}`;
  if (status === 429) {
    const seconds = retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;
    return new AiRateLimitError(`DeepSeek rate limit: ${message}`, Number.isFinite(seconds) ? seconds * 1000 : 30_000);
  }
  // Overloaded or down: worth another try later
  if (status >= 500 || status === 408) return new AiTemporaryError(`DeepSeek ${status}: ${message}`);
  // Out of credit: everything waits until the account is topped up (see pipeline/build.ts)
  if (status === 402) return new AiOutOfCreditError("DeepSeek: the account is out of credit (402 Insufficient Balance)");
  // 401 bad key, 400/422 bad request: trying again won't help
  return new AiPermanentError(`DeepSeek ${status}: ${message}`);
}

// DeepSeek speaks the OpenAI chat format. Its JSON mode guarantees valid JSON but can't force our exact shape,
// so the shape goes into the instructions and our schema check (zod) catches anything that doesn't fit
export function createDeepSeekProvider(options: DeepSeekOptions): AiProvider {
  return {
    name: "deepseek",
    requestsPerMinute: options.requestsPerMinute,
    modelFor: (tier) => options.models[tier],

    async generate(request: AiRequest): Promise<AiResult> {
      const model = options.models[request.tier];
      const body = {
        model,
        messages: [
          { role: "system", content: instructionsWithShape(request.system, request.jsonSchema) },
          { role: "user", content: JSON.stringify(request.input) },
        ],
        response_format: { type: "json_object" },
        max_tokens: request.maxOutputTokens,
        temperature: 0.2,
        // Thinking costs hundreds of extra paid tokens per call and was 3-15x slower in our tests, for the same
        // answers. Our own checks do the careful part
        thinking: { type: "disabled" },
        stream: false,
      };

      let res: Response;
      try {
        res = await fetch(`${options.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw err;
        throw new AiTemporaryError(`Couldn't reach DeepSeek: ${err instanceof Error ? err.message : String(err)}`);
      }

      let json: DeepSeekResponse;
      try {
        json = (await res.json()) as DeepSeekResponse;
      } catch {
        throw res.ok ? new AiTemporaryError("DeepSeek sent an answer that isn't JSON") : toError(res.status, {}, res.headers.get("retry-after"));
      }
      if (!res.ok) throw toError(res.status, json, res.headers.get("retry-after"));

      const choice = json.choices?.[0];
      if (!choice) throw new AiTemporaryError("DeepSeek sent no answer");
      if (choice.finish_reason === "content_filter") throw new AiPermanentError("DeepSeek refused to answer (content filter)");

      const usage = json.usage ?? {};
      return {
        text: choice.message?.content ?? "",
        model,
        inputTokens: usage.prompt_tokens ?? 0,
        cachedInputTokens: usage.prompt_cache_hit_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        truncated: choice.finish_reason === "length",
      };
    },
  };
}
