import { CP1252_TO_BYTE } from "../decode-text";

// An "Ã", "Â", "â" or "Å" followed by a Latin-1 or Windows-1252 symbol is the typical sign of broken UTF-8
const MOJIBAKE_HINT = /[\u00c3\u00c2\u00e2\u00c5][\u0080-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013-\u203a\u20ac\u2122]/;

// "GrÃ¼n" -> "Grün". This happens when UTF-8 text was opened as Windows-1252 somewhere along the way.
// We turn the characters back into bytes and read them as UTF-8. If that isn't valid UTF-8, the text
// wasn't broken in the first place and we leave it alone
export function fixMojibake(text: string): string {
  if (!MOJIBAKE_HINT.test(text)) return text;

  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else {
      const b = CP1252_TO_BYTE.get(char);
      if (b === undefined) return text;
      bytes.push(b);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return text;
  }
}

// Trims, fixes broken characters, removes invisible characters and squeezes repeated spaces.
// Returns null for empty cells
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = fixMojibake(value)
    .normalize("NFC")
    // zero-width spaces and joiners, word joiner, byte order mark, soft hyphen
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "")
    // control characters
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // non-breaking and thin spaces
    .replace(/[\u00a0\u2007\u202f\u2009]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned;
}
