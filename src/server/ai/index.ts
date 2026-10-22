import { env } from "@/server/env";
import { createAnthropicProvider } from "./anthropic";
import { createDeepSeekProvider } from "./deepseek";
import { mockProvider } from "./mock";
import type { AiProvider } from "./provider";

export function getAiProvider(): AiProvider {
  const config = env();
  switch (config.AI_PROVIDER) {
    case "mock":
      return mockProvider;
    case "anthropic":
      if (!config.ANTHROPIC_API_KEY) throw new Error("AI_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set in .env.local");
      return createAnthropicProvider({
        apiKey: config.ANTHROPIC_API_KEY,
        baseUrl: config.ANTHROPIC_BASE_URL,
        models: { cheap: config.ANTHROPIC_MODEL_CHEAP, strong: config.ANTHROPIC_MODEL_STRONG },
        requestsPerMinute: config.AI_REQUESTS_PER_MINUTE,
      });
    case "deepseek":
      if (!config.DEEPSEEK_API_KEY) throw new Error("AI_PROVIDER is deepseek but DEEPSEEK_API_KEY is not set in .env.local");
      return createDeepSeekProvider({
        apiKey: config.DEEPSEEK_API_KEY,
        baseUrl: config.DEEPSEEK_BASE_URL,
        models: { cheap: config.DEEPSEEK_MODEL_CHEAP, strong: config.DEEPSEEK_MODEL_STRONG },
        requestsPerMinute: config.AI_REQUESTS_PER_MINUTE,
      });
  }
}
