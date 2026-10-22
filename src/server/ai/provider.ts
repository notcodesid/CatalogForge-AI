// "cheap" for clean, simple products; "strong" for messy ones (other languages, conflicts, missing names)
export type AiTier = "cheap" | "strong";

// What the call is for: writing products from supplier data, or translating them
export type AiPurpose = "build" | "translate";

export type AiRequest = {
  purpose: AiPurpose;
  tier: AiTier;
  system: string;
  // Sent to the AI as JSON
  input: object;
  jsonSchema: object;
  maxOutputTokens: number;
  signal?: AbortSignal;
};

export type AiResult = {
  // The raw answer, expected to be JSON matching buildResponseSchema
  text: string;
  model: string;
  inputTokens: number;
  // Part of inputTokens the provider had seen before (cached), billed at a lower price
  cachedInputTokens?: number;
  // Part of inputTokens the provider stored for later calls, billed a little above the normal price (Claude)
  cacheWriteInputTokens?: number;
  outputTokens: number;
  // The answer stopped because it hit maxOutputTokens: it's cut off and can't be trusted
  truncated: boolean;
};

export interface AiProvider {
  name: string;
  // The provider's limit; calls are spaced out to stay under it (see rate-limit.ts). No limit if not set
  requestsPerMinute?: number;
  modelFor(tier: AiTier): string;
  generate(request: AiRequest): Promise<AiResult>;
}

// Neither provider can force our exact shape (Claude's strict JSON mode has no maps with free keys, like
// attributes and confidence), so the shape goes into the instructions and our schema check (zod) catches
// anything that doesn't fit
export function instructionsWithShape(system: string, jsonSchema: object): string {
  const shape: Record<string, unknown> = { ...(jsonSchema as Record<string, unknown>) };
  delete shape.$schema;
  return `${system}\n\nAnswer in json, exactly matching this JSON Schema:\n${JSON.stringify(shape)}`;
}

// Too many requests. Everything waits until retryAfterMs has passed
export class AiRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

// Timeouts, overloaded, 5xx: worth trying again later
export class AiTemporaryError extends Error {}

// Bad API key, request refused: trying again won't help
export class AiPermanentError extends Error {}

// The account has no credit left. Nothing works until someone tops it up, then everything should carry on
export class AiOutOfCreditError extends Error {}
