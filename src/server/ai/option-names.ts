import { cleanText } from "@/server/pipeline/clean/text";
import type { ProductInput } from "./prompt";

// A supplier's colour or size column sometimes holds something else: scents ("Lavender", "Cedar") in the Colour
// column of a candle sheet, pack sizes in Size. The AI says what the column really holds, and the variants' option
// is shown under that name ("Scent: lavender", not "Colour: lavender")

const RENAMABLE = ["color", "size"] as const;
export type OptionNames = Partial<Record<(typeof RENAMABLE)[number], string>>;

const isRenamable = (key: string): key is (typeof RENAMABLE)[number] => (RENAMABLE as readonly string[]).includes(key);

// A short lowercase name, letters and spaces only: "scent", "pack size"
const OPTION_NAME = /^[a-z]+(?: [a-z]+)*$/;
const MAX_NAME_LENGTH = 20;

const hasKey = (options: Record<string, string>, name: string) => Object.keys(options).some((k) => k.toLowerCase() === name);

// The AI's names we can use: for colour or size only, when a variant has that option, and never a name the
// variants already use for another option ("material", or "size" for the colour)
export function cleanOptionNames(names: Record<string, string> | null | undefined, variants: ProductInput["variants"]): OptionNames {
  const taken = new Set(["color", "colour", "size", ...variants.flatMap((v) => Object.keys(v.options).map((k) => k.toLowerCase()))]);
  const result: OptionNames = {};
  for (const [rawKey, rawName] of Object.entries(names ?? {})) {
    const key = cleanText(rawKey)?.toLowerCase().replace(/^colour$/, "color") ?? "";
    const name = cleanText(rawName)?.toLowerCase() ?? "";
    if (!isRenamable(key) || !variants.some((v) => v[key])) continue;
    if (name.length > MAX_NAME_LENGTH || !OPTION_NAME.test(name) || taken.has(name)) continue;
    result[key] = name;
    taken.add(name);
  }
  return result;
}

// A variant's options under those names: { color: "lavender", size: "200 g" } with { color: "scent" } becomes
// { scent: "lavender", size: "200 g" }. A name the variant already has is never overwritten
export function renameOptions(options: Record<string, string>, names: OptionNames): Record<string, string> {
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => {
      const name = isRenamable(key) ? names[key] : undefined;
      return [name && !hasKey(options, name) ? name : key, value];
    }),
  );
}

// Saving merges a variant's new options into the ones an earlier upload saved (a price list without a colour column
// doesn't erase the colour). These are the earlier keys that now go under another name: "color" once it's called
// "scent", or "scent" once it's "color" again. Removed before merging, or the old name stays next to the new one
export function replacedOptionKeys(options: Record<string, string>, names: OptionNames, previous: OptionNames = {}): string[] {
  const renamed = renameOptions(options, names);
  const keys = RENAMABLE.filter((key) => options[key]).flatMap((key) => [key, previous[key]]);
  return [...new Set(keys.filter((key): key is string => key !== undefined && !hasKey(renamed, key)))];
}
