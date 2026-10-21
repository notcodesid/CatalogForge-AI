import { describe, expect, it } from "vitest";
import { detectDecimalSeparator, parsePrice } from "./price";

const base = { defaultCurrency: "EUR" };

describe("parsePrice", () => {
  it.each([
    // [cell, currency column, cents, currency]
    ["24,99 €", null, 2499, "EUR"],
    ["1.299,00 €", null, 129900, "EUR"],
    ["€ 39.90", null, 3990, "EUR"],
    ["EUR 24", null, 2400, "EUR"],
    ["£8", null, 800, "GBP"],
    ["14.00", "EUR", 1400, "EUR"],
    ["$1,299.00", null, 129900, "USD"],
    ["1'299.50 CHF", null, 129950, "CHF"],
    ["1.299.000 €", null, 129900000, "EUR"],
  ])("reads %s as %i %s", (cell, currencyColumn, cents, currency) => {
    expect(parsePrice(cell, { ...base, currencyColumn })).toEqual({ ok: true, cents, currency, currencyAssumed: false });
  });

  it("uses the import's default currency when nothing says which one, and says so", () => {
    expect(parsePrice("12.5", base)).toEqual({ ok: true, cents: 1250, currency: "EUR", currencyAssumed: true });
  });

  it("uses the currency from the header before the default", () => {
    expect(parsePrice("12,50", { ...base, currencyHint: "GBP" })).toMatchObject({ cents: 1250, currency: "GBP", currencyAssumed: false });
  });

  it.each([
    ["", "No price"],
    [null, "No price"],
    ["on request", 'Price is "on request", not a number'],
    ["auf Anfrage", 'Price is "auf Anfrage", not a number'],
    ["0", "Price is 0"],
    ["-5.00", "Price is negative (-5.00)"],
    ["(5.00)", "Price is negative ((5.00))"],
    ["12.9999", "has more than 2 decimals"],
    ["abc", "isn't a number"],
  ])("never guesses: %s -> %s", (cell, reason) => {
    const result = parsePrice(cell, base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it("flags 1,299 as unclear when nothing else in the column says which separator is the decimal", () => {
    const result = parsePrice("1,299", base);
    expect(result).toMatchObject({ ok: false });
  });

  it("settles 1,299 using the rest of the column", () => {
    expect(parsePrice("1,299", { ...base, decimalSeparator: "." })).toMatchObject({ ok: true, cents: 129900 });
  });

  it("refuses a price whose symbol and Currency column disagree", () => {
    expect(parsePrice("£8", { ...base, currencyColumn: "EUR" })).toEqual({
      ok: false,
      reason: "Price says GBP but the Currency column says EUR",
    });
  });
});

describe("detectDecimalSeparator", () => {
  it("finds the comma in a German-style column", () => {
    expect(detectDecimalSeparator(["24,99", "1.299,00", "8"])).toBe(",");
  });

  it("gives up when the column mixes both styles", () => {
    expect(detectDecimalSeparator(["24,99 €", "12.5"])).toBeNull();
  });
});
