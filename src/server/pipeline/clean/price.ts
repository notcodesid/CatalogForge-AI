import { cleanText } from "./text";

export const CURRENCY_CODES = new Set([
  "EUR", "GBP", "USD", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "CAD", "AUD", "NZD", "JPY",
]);

const SYMBOLS: [RegExp, string][] = [
  [/€/g, "EUR"],
  [/£/g, "GBP"],
  [/US\$|\$/g, "USD"],
  [/¥/g, "JPY"],
  [/\bFr\./gi, "CHF"],
];

// Words suppliers write instead of a price
const NO_PRICE = /^(n\/?a|none|-+|–|tbd|tba|poa|p\.o\.a\.?|on request|price on request|ask|call|auf anfrage|preis auf anfrage|sur demande|sur devis|prix sur demande)$/i;

export type PriceResult =
  | { ok: true; cents: number; currency: string; currencyAssumed: boolean }
  | { ok: false; reason: string };

export type PriceOptions = {
  // Value of the Currency column for this row, if the sheet has one
  currencyColumn?: string | null;
  // Currency written in the header, e.g. "Price (EUR)"
  currencyHint?: string | null;
  // The import's default, used when nothing else says which currency
  defaultCurrency: string;
  // Decimal separator used by the rest of this column, to settle values like "1,299"
  decimalSeparator?: "," | "." | null;
};

function toCurrencyCode(value: string): string | null {
  const upper = value.trim().toUpperCase();
  if (CURRENCY_CODES.has(upper)) return upper;
  for (const [pattern, code] of SYMBOLS) {
    pattern.lastIndex = 0;
    if (pattern.test(value.trim())) return code;
  }
  return null;
}

// Pulls a currency symbol or code out of the price text: "24,99 €" -> ["24,99", "EUR"]
function extractCurrency(text: string): { rest: string; currency: string | null; conflict: boolean } {
  const found = new Set<string>();
  let rest = text;
  for (const [pattern, code] of SYMBOLS) {
    if (rest.match(pattern)) {
      found.add(code);
      rest = rest.replace(pattern, " ");
    }
  }
  rest = rest.replace(/\b[A-Za-z]{3}\b/g, (word) => {
    const code = word.toUpperCase();
    if (!CURRENCY_CODES.has(code)) return word;
    found.add(code);
    return " ";
  });
  return { rest, currency: found.size === 1 ? [...found][0] : null, conflict: found.size > 1 };
}

// Which separator a single value uses for decimals, if we can tell for sure
function decimalOf(digits: string): "," | "." | null {
  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) return lastDot > lastComma ? "." : ",";
  const sep = lastDot !== -1 ? "." : lastComma !== -1 ? "," : null;
  if (!sep) return null;
  const count = digits.split(sep).length - 1;
  const after = digits.length - digits.lastIndexOf(sep) - 1;
  // "24,99" or "12.5" is a decimal. "1,299" could be either. "1.299.000" is thousands
  if (count === 1 && after !== 3) return sep;
  return null;
}

// Looks at a whole price column and returns the decimal separator its clear values use ("24,99" -> ",").
// parsePrice uses it to settle values like "1,299" that could be read either way
export function detectDecimalSeparator(values: (string | null | undefined)[]): "," | "." | null {
  let commas = 0;
  let dots = 0;
  for (const value of values) {
    if (!value) continue;
    const digits = value.replace(/[^\d.,]/g, "");
    const sep = decimalOf(digits);
    if (sep === ",") commas++;
    if (sep === ".") dots++;
  }
  if (commas > 0 && dots === 0) return ",";
  if (dots > 0 && commas === 0) return ".";
  return null;
}

export function parsePrice(raw: string | null | undefined, options: PriceOptions): PriceResult {
  const text = cleanText(raw);
  if (!text) return { ok: false, reason: "No price" };
  if (NO_PRICE.test(text)) return { ok: false, reason: `Price is "${text}", not a number` };

  const { rest, currency: fromValue, conflict } = extractCurrency(text);
  if (conflict) return { ok: false, reason: `Price "${text}" has more than one currency` };

  // Remove spaces and Swiss-style apostrophes used as thousands separators: 1'299.00
  let digits = rest.replace(/[\s'’]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(digits)) {
    negative = true;
    digits = digits.slice(1, -1);
  }
  if (digits.startsWith("-") || digits.endsWith("-")) {
    negative = true;
    digits = digits.replace(/^-|-$/g, "");
  }
  if (!/^[\d.,]*\d[\d.,]*$/.test(digits)) return { ok: false, reason: `Price "${text}" isn't a number` };

  // Work out which separator is the decimal one
  let decimal = decimalOf(digits);
  if (!decimal && /[.,]/.test(digits)) {
    const sep = digits.includes(",") ? "," : ".";
    const count = digits.split(sep).length - 1;
    if (count > 1) {
      decimal = sep === "," ? "." : ",";
    } else if (options.decimalSeparator) {
      // "1,299" alone is unclear, but if the rest of the column uses "," for decimals, it's 1.299
      decimal = options.decimalSeparator;
    } else {
      return { ok: false, reason: `Price "${text}" is unclear: is it ${digits.replace(sep, ".")} or ${digits.replace(sep, "")}?` };
    }
  }

  let whole = digits;
  let fraction = "";
  if (decimal && digits.includes(decimal)) {
    const at = digits.lastIndexOf(decimal);
    whole = digits.slice(0, at);
    fraction = digits.slice(at + 1);
  }
  const thousands = decimal === "," ? "." : ",";
  whole = whole.split(thousands).join("");
  if (/[.,]/.test(whole) || /[.,]/.test(fraction)) return { ok: false, reason: `Price "${text}" isn't a number` };

  // Cents only. "24.990" is fine, "24.999" isn't a real price
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length > 2) return { ok: false, reason: `Price "${text}" has more than 2 decimals` };

  // Integer maths on the digits, never floats
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000_00) return { ok: false, reason: `Price "${text}" is too large` };
  if (negative) return { ok: false, reason: `Price is negative (${text})` };
  if (cents === 0) return { ok: false, reason: "Price is 0" };

  // Which currency: the price text, then the Currency column, then the header, then the import default
  const fromColumnText = cleanText(options.currencyColumn);
  const fromColumn = fromColumnText ? toCurrencyCode(fromColumnText) : null;
  if (fromColumnText && !fromColumn) return { ok: false, reason: `Unknown currency "${fromColumnText}"` };
  if (fromValue && fromColumn && fromValue !== fromColumn) {
    return { ok: false, reason: `Price says ${fromValue} but the Currency column says ${fromColumn}` };
  }

  const currency = fromValue ?? fromColumn ?? options.currencyHint ?? null;
  if (currency) return { ok: true, cents, currency, currencyAssumed: false };
  return { ok: true, cents, currency: options.defaultCurrency, currencyAssumed: true };
}

export function formatPrice(cents: number, currency: string) {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
