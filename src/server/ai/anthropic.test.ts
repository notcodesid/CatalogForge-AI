import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider, thinkingOff } from "./anthropic";
import { costMicroUsd } from "./pricing";
import { AiOutOfCreditError, AiPermanentError, AiRateLimitError, AiTemporaryError, type AiRequest } from "./provider";

const claude = createAnthropicProvider({
  apiKey: "test-key",
  baseUrl: "https://api.anthropic.test",
  models: { cheap: "claude-haiku-5-5", strong: "claude-sonnet-5-5" },
  requestsPerMinute: 60,
});

const request: AiRequest = {
  purpose: "build",
  tier: "cheap",
  system: "rules",
  input: { categories: ["Other"], products: [] },
  jsonSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
  maxOutputTokens: 100,
};

const reply = (text: string, extra: object = {}) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", ...extra });

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof answer>) {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
}

afterEach(() => vi.unstubAllGlobals());

describe("Claude provider", () => {
  it("sends our instructions with the answer's shape, marked for caching, and reads the answer and token use", async () => {
    const fetchMock = answer(
      200,
      reply('{"products":[]}', { usage: { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 1800, output_tokens: 120 } }),
    );

    const result = await claude.generate(request);

    // Claude counts cached input apart from the rest: inputTokens is all of it
    expect(result).toEqual({
      text: '{"products":[]}',
      model: "claude-haiku-5-5",
      inputTokens: 2100,
      cachedInputTokens: 1800,
      cacheWriteInputTokens: 0,
      outputTokens: 120,
      truncated: false,
    });
    const { url, headers, body } = sent(fetchMock);
    expect(url).toBe("https://api.anthropic.test/v1/messages");
    expect(headers).toMatchObject({ "x-api-key": "test-key", "anthropic-version": "2023-06-01" });
    expect(body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 100, thinking: { type: "disabled" } });
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[0].text).toContain("Answer in json");
    expect(body.system[0].text).toContain('{"type":"object"}');
    expect(body.system[0].text).not.toContain("$schema");
    expect(body.messages).toEqual([{ role: "user", content: JSON.stringify(request.input) }]);
    // These models refuse temperature
    expect(body).not.toHaveProperty("temperature");
  });

  it("uses the stronger model for messy products, with that model's way of turning thinking off", async () => {
    const fetchMock = answer(200, reply("{}"));
    await claude.generate({ ...request, tier: "strong" });
    expect(sent(fetchMock).body).toMatchObject({ model: "claude-sonnet-5-5", thinking: { type: "between_tools" } });
  });

  it("turns thinking off the way each model accepts", () => {
    expect(thinkingOff("claude-haiku-5-5")).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingOff("claude-sonnet-5-5")).toEqual({ thinking: { type: "between_tools" } });
    expect(thinkingOff("claude-opus-5-5")).toEqual({ output_config: { effort: "low" } });
  });

  it("counts input stored in the cache for the next calls", async () => {
    answer(200, reply("{}", { usage: { input_tokens: 300, cache_creation_input_tokens: 1800, cache_read_input_tokens: 0, output_tokens: 10 } }));
    expect(await claude.generate(request)).toMatchObject({ inputTokens: 2100, cachedInputTokens: 0, cacheWriteInputTokens: 1800 });
  });

  it("unwraps an answer sent inside a ```json block", async () => {
    answer(200, reply('```json\n{"products":[]}\n```'));
    expect((await claude.generate(request)).text).toBe('{"products":[]}');
  });

  it("marks an answer cut off at the output limit", async () => {
    answer(200, reply('{"products":[{"ke', { stop_reason: "max_tokens" }));
    expect((await claude.generate(request)).truncated).toBe(true);
  });

  it("treats a declined answer as one that won't work on a retry either", async () => {
    answer(200, reply("", { stop_reason: "refusal" }));
    await expect(claude.generate(request)).rejects.toBeInstanceOf(AiPermanentError);
  });

  it("turns 'too many requests' into a rate-limit error, using Retry-After when given", async () => {
    answer(429, { type: "error", error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" } }, { "retry-after": "12" });
    const err = await claude.generate(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRateLimitError);
    expect((err as AiRateLimitError).retryAfterMs).toBe(12_000);
  });

  it.each([
    ["an empty prepaid balance", 400, { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." }],
    [
      "the organization's spend limit",
      429,
      { type: "rate_limit_error", message: "You have reached your API usage limits", details: { error_code: "enforced_spend_limit_reached" } },
    ],
  ])("reports %s as out of credit, so the import waits for a top-up instead of retrying", async (_case, status, error) => {
    answer(status, { type: "error", error });
    await expect(claude.generate(request)).rejects.toBeInstanceOf(AiOutOfCreditError);
  });

  it.each([
    [529, AiTemporaryError],
    [500, AiTemporaryError],
    [401, AiPermanentError],
    [400, AiPermanentError],
    [404, AiPermanentError],
  ])("treats HTTP %i as %o", async (status, kind) => {
    answer(status, { type: "error", error: { type: "some_error", message: "nope" } });
    await expect(claude.generate(request)).rejects.toBeInstanceOf(kind);
  });

  it("turns a network failure into a temporary error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(claude.generate(request)).rejects.toBeInstanceOf(AiTemporaryError);
  });
});

describe("Claude cost", () => {
  const peak = new Date("2026-10-22T07:00:00Z"); // a Thursday, 07:00 UTC: DeepSeek's peak, not Claude's

  it("bills new input, cache reads, cache writes and output each at their own price", () => {
    // 300 new x $0.10 + 1,800 read x $0.01 + 0 written + 120 out x $0.50 = 30 + 18 + 60 = 108 millionths
    expect(costMicroUsd("claude-haiku-5-5", { inputTokens: 2100, cachedInputTokens: 1800, cacheWriteInputTokens: 0, outputTokens: 120 })).toBe(108);
    // 300 new x $0.10 + 1,800 written x $0.125 + 120 out x $0.50 = 30 + 225 + 60 = 315 millionths
    expect(costMicroUsd("claude-haiku-5-5", { inputTokens: 2100, cachedInputTokens: 0, cacheWriteInputTokens: 1800, outputTokens: 120 })).toBe(315);
    // 300 new x $2 + 1,800 read x $0.10 + 120 out x $10 = 600 + 180 + 1,200 = 1,980 millionths
    expect(costMicroUsd("claude-sonnet-5-5", { inputTokens: 2100, cachedInputTokens: 1800, outputTokens: 120 })).toBe(1980);
  });

  it("has no peak hours", () => {
    const usage = { inputTokens: 2100, cachedInputTokens: 1800, outputTokens: 120 };
    expect(costMicroUsd("claude-haiku-5-5", usage, peak)).toBe(108);
  });
});
