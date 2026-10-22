import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeepSeekProvider } from "./deepseek";
import { costMicroUsd } from "./pricing";
import { AiOutOfCreditError, AiPermanentError, AiRateLimitError, AiTemporaryError, type AiRequest } from "./provider";

const deepseek = createDeepSeekProvider({
  apiKey: "test-key",
  baseUrl: "https://api.deepseek.test",
  models: { cheap: "deepseek-flash", strong: "deepseek-v4-pro" },
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

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof answer>) {
  return JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
}

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek provider", () => {
  it("asks for JSON in our shape, with thinking off, and reads the answer and token use", async () => {
    const fetchMock = answer(200, {
      choices: [{ message: { content: '{"products":[]}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 120, prompt_cache_hit_tokens: 640 },
    });

    const result = await deepseek.generate(request);

    expect(result).toEqual({ text: '{"products":[]}', model: "deepseek-flash", inputTokens: 900, cachedInputTokens: 640, outputTokens: 120, truncated: false });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.deepseek.test/chat/completions");
    const body = sentBody(fetchMock);
    expect(body).toMatchObject({ model: "deepseek-flash", response_format: { type: "json_object" }, thinking: { type: "disabled" } });
    // JSON mode needs the word "json" and our shape in the instructions
    expect(body.messages[0].content).toContain("Answer in json");
    expect(body.messages[0].content).toContain('{"type":"object"}');
    expect(body.messages[0].content).not.toContain("$schema");
  });

  it("uses the stronger model for messy products", async () => {
    const fetchMock = answer(200, { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
    await deepseek.generate({ ...request, tier: "strong" });
    expect(sentBody(fetchMock).model).toBe("deepseek-v4-pro");
  });

  it("marks an answer cut off at the output limit", async () => {
    answer(200, { choices: [{ message: { content: '{"products":[{"ke' }, finish_reason: "length" }] });
    expect((await deepseek.generate(request)).truncated).toBe(true);
  });

  it("turns 'too many requests' into a rate-limit error, using Retry-After when given", async () => {
    answer(429, { error: { message: "Rate limit reached" } }, { "retry-after": "12" });
    const err = await deepseek.generate(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRateLimitError);
    expect((err as AiRateLimitError).retryAfterMs).toBe(12_000);
  });

  it("reports an empty account as out of credit, so the import can wait for a top-up", async () => {
    answer(402, { error: { message: "Insufficient Balance" } });
    await expect(deepseek.generate(request)).rejects.toThrow("the account is out of credit");
    await expect(deepseek.generate(request)).rejects.toBeInstanceOf(AiOutOfCreditError);
  });

  it.each([
    [503, AiTemporaryError],
    [500, AiTemporaryError],
    [401, AiPermanentError],
    [400, AiPermanentError],
    [422, AiPermanentError],
  ])("treats HTTP %i as %o", async (status, kind) => {
    answer(status, { error: { message: "nope" } });
    await expect(deepseek.generate(request)).rejects.toBeInstanceOf(kind);
  });

  it("turns a network failure into a temporary error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(deepseek.generate(request)).rejects.toBeInstanceOf(AiTemporaryError);
  });
});

describe("DeepSeek cost", () => {
  const offPeak = new Date("2026-10-24T12:00:00Z"); // a Saturday
  const peak = new Date("2026-10-22T07:00:00Z"); // a Thursday, 07:00 UTC

  it("bills input it has seen before at the cached price", () => {
    // 360 new x $0.15 + 640 cached x $0.003 + 120 out x $0.60 = 54 + 1.92 + 72 = 127.92 millionths
    expect(costMicroUsd("deepseek-flash", { inputTokens: 1000, cachedInputTokens: 640, outputTokens: 120 }, offPeak)).toBe(128);
  });

  it("doubles at peak times", () => {
    expect(costMicroUsd("deepseek-flash", { inputTokens: 1000, cachedInputTokens: 640, outputTokens: 120 }, peak)).toBe(256);
  });

  it("records the mock AI as free", () => {
    expect(costMicroUsd("mock-cheap", { inputTokens: 1000, outputTokens: 500 })).toBe(0);
  });
});
