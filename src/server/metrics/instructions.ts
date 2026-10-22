import { SYSTEM_PROMPT } from "@/server/ai/prompt";
import { instructionsWithShape } from "@/server/ai/provider";
import { buildResponseJsonSchema } from "@/server/ai/schema";
import { CATEGORIES } from "@/server/ai/taxonomy";
import { translateResponseJsonSchema, translateSystemPrompt } from "@/server/translations/prompt";

// The part of every AI call that doesn't depend on the products in it, measured from the real texts, as both
// providers send them: the instructions with the answer's shape appended, and for the AI step the list of
// categories at the start of the input. Used to estimate what batching saves (see savings.ts)

export const BUILD_INSTRUCTIONS_CHARS =
  instructionsWithShape(SYSTEM_PROMPT, buildResponseJsonSchema).length + JSON.stringify({ categories: CATEGORIES }).length;

// German and French instructions differ by a few words: their average
export const TRANSLATE_INSTRUCTIONS_CHARS = Math.round(
  (instructionsWithShape(translateSystemPrompt("de"), translateResponseJsonSchema).length +
    instructionsWithShape(translateSystemPrompt("fr"), translateResponseJsonSchema).length) /
    2,
);
