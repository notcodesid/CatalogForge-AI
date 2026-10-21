export type SheetType = "csv" | "xlsx" | "xls";

export type DetectResult = { ok: true; type: SheetType } | { ok: false; reason: string };

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((b, i) => bytes[i] === b);
}

// Looks at the first bytes of the file, not the file name. A PDF renamed to .csv is still a PDF
export function detectSheetType(bytes: Uint8Array): DetectResult {
  if (bytes.length === 0) return { ok: false, reason: "The file is empty" };

  // XLSX is a ZIP file
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return { ok: true, type: "xlsx" };
  // Old .xls, or an XLSX that is password protected (both use this container)
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { ok: true, type: "xls" };

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { ok: false, reason: "This is a PDF, not a spreadsheet. Upload a CSV or XLSX file" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { ok: false, reason: "This is an image, not a spreadsheet. Upload a CSV or XLSX file" };
  }

  // UTF-16 text (Excel's "Unicode text" export) starts with a byte order mark
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return { ok: true, type: "csv" };

  // Plain text never contains NUL bytes. Binary files almost always do
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return { ok: false, reason: "This doesn't look like a CSV or XLSX file" };

  return { ok: true, type: "csv" };
}
