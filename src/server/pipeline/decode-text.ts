// Windows-1252 is Latin-1 except for bytes 0x80-0x9F, which hold € ‚ „ … ’ “ ” – — ™ and friends.
// We use our own table because Node's TextDecoder("windows-1252") treats those bytes as Latin-1
// control characters, which would turn "12,90 €" into "12,90 \u0080"
const CP1252_HIGH: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰",
  0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•",
  0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

// Character -> byte, for the characters above. Used to undo broken text (see fixMojibake)
export const CP1252_TO_BYTE = new Map(Object.entries(CP1252_HIGH).map(([byte, char]) => [char, Number(byte)]));

function decodeWindows1252(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += CP1252_HIGH[byte] ?? String.fromCharCode(byte);
  return text;
}

// Turns the raw bytes of a CSV into text. German Excel often saves CSVs as Windows-1252, not UTF-8,
// so if the bytes aren't valid UTF-8 we read them as Windows-1252 instead of showing broken characters
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  }

  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: decodeWindows1252(bytes), encoding: "windows-1252" };
  }
}
