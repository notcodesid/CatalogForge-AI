import Papa from "papaparse";
import * as XLSX from "xlsx";
import { headerScore, mapColumns, normalizeHeader } from "./columns";
import { decodeText } from "./decode-text";
import type { SheetType } from "./detect-file-type";
import type { Field, ParseInfo } from "./types";

const MAX_ROWS = 10_000;

// A problem with the file itself. The import fails with this message and isn't retried
export class ImportFileError extends Error {}

type GridRow = { rowNumber: number; cells: string[] };

type Grid = {
  rows: GridRow[];
  encoding?: string;
  delimiter?: string;
  sheetName?: string;
};

export type SheetRow = {
  // The row number the merchant sees in their sheet
  rowNumber: number;
  // Header -> cell text, for every column
  values: Record<string, string>;
};

export type ReadSheetResult = {
  headers: string[];
  rows: SheetRow[];
  info: ParseInfo;
};

function readCsv(bytes: Uint8Array): Grid {
  const { text, encoding } = decodeText(bytes);
  // Files edited in several tools can mix Windows (\r\n) and Unix (\n) line endings. The parser picks one,
  // so lines with the other kind would be glued to the next row. Make them all \n first
  const normalized = text.replace(/\r\n?/g, "\n");
  // Papa works out the separator itself: comma, semicolon (German Excel), tab or pipe
  const parsed = Papa.parse<string[]>(normalized, { skipEmptyLines: false });
  const rows = parsed.data.map((cells, i) => ({ rowNumber: i + 1, cells: cells.map((c) => c ?? "") }));
  return { rows, encoding, delimiter: parsed.meta.delimiter };
}

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return "";
  switch (cell.t) {
    case "s":
      return String(cell.v);
    case "n":
      // Keep leading zeros when the cell is formatted to show them (e.g. SKU 00123 stored as the number 123)
      if (cell.z && /^0+$/.test(String(cell.z)) && cell.w) return cell.w;
      return String(cell.v);
    case "b":
      return cell.v ? "TRUE" : "FALSE";
    case "d":
      return cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : String(cell.v);
    case "e":
      // Excel error like #N/A
      return "";
    default:
      return String(cell.v);
  }
}

function readXlsx(bytes: Uint8Array): Grid {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array", cellDates: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/password|encrypt/i.test(message)) {
      throw new ImportFileError("This spreadsheet is password protected. Remove the password and upload it again");
    }
    throw new ImportFileError("This spreadsheet can't be read. It may be damaged");
  }

  // Use the sheet with the most filled rows (suppliers sometimes add a cover or notes sheet)
  let best: { name: string; rows: GridRow[]; filled: number } | null = null;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);

    // Merged cells only store their value in the top-left cell. Copy it into the rest of the area
    const filledValues = new Map<string, string>();
    for (const merge of sheet["!merges"] ?? []) {
      const value = cellText(sheet[XLSX.utils.encode_cell(merge.s)]);
      for (let r = merge.s.r; r <= merge.e.r; r++) {
        for (let c = merge.s.c; c <= merge.e.c; c++) filledValues.set(`${r}:${c}`, value);
      }
    }

    const rows: GridRow[] = [];
    let filled = 0;
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cells: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        cells.push(filledValues.get(`${r}:${c}`) ?? cellText(sheet[XLSX.utils.encode_cell({ r, c })]));
      }
      if (cells.some((c) => c.trim())) filled++;
      rows.push({ rowNumber: r + 1, cells });
    }
    if (!best || filled > best.filled) best = { name, rows, filled };
  }

  if (!best) throw new ImportFileError("The spreadsheet has no data");
  return { rows: best.rows, sheetName: best.name };
}

function isBlank(cells: string[]) {
  return cells.every((c) => !c.trim());
}

// A row with text in only one cell isn't a product: it's a footer ("Prices subject to change"), a note,
// or a section title ("Garden tools"). The one exception is a lone SKU, which is a product with
// everything else missing, so we keep it and it goes to review
function isNoteRow(cells: string[], skuColumn: number | undefined) {
  const filled = cells.map((c, i) => ({ text: c.trim(), i })).filter((c) => c.text);
  if (filled.length !== 1) return false;
  const [only] = filled;
  return !(only.i === skuColumn && !/\s/.test(only.text));
}

// The header is usually the first row, but some suppliers put a title or logo row above it.
// Pick the row (within the first 10 filled rows) that matches the most known column names
function findHeaderRow(rows: GridRow[]): number {
  const candidates = rows.filter((r) => !isBlank(r.cells)).slice(0, 10);
  let bestIndex = -1;
  let bestScore = 0;
  for (const row of candidates) {
    const score = headerScore(row.cells);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = rows.indexOf(row);
    }
  }
  if (bestScore < 2) {
    throw new ImportFileError(
      "Couldn't find the header row. The sheet needs column names like SKU, Product Name, Description and Price",
    );
  }
  return bestIndex;
}

// Two columns can't share a name in our row data, so "Notes", "Notes" becomes "Notes", "Notes (2)"
function uniqueHeaders(cells: string[]) {
  const seen = new Map<string, number>();
  return cells.map((cell, i) => {
    const base = cell.trim() || `Column ${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function wooColumns(headers: string[]) {
  const find = (name: string) => headers.find((h) => normalizeHeader(h) === name)!;
  return { idColumn: find("id"), typeColumn: find("type") };
}

export function readSheet(bytes: Uint8Array, type: SheetType): ReadSheetResult {
  const grid = type === "csv" ? readCsv(bytes) : readXlsx(bytes);

  if (grid.rows.every((r) => isBlank(r.cells))) throw new ImportFileError("The file has no data");

  const headerIndex = findHeaderRow(grid.rows);
  const headers = uniqueHeaders(grid.rows[headerIndex].cells);
  const mapping = mapColumns(headers);

  if (mapping.columns.sku === undefined && mapping.columns.title === undefined && mapping.columns.description === undefined) {
    throw new ImportFileError("No SKU, product name or description column found. Check the header row");
  }

  const rows: SheetRow[] = [];
  const ignoredRows: { rowNumber: number; text: string }[] = [];
  let blankRows = 0;
  for (const row of grid.rows.slice(headerIndex + 1)) {
    if (isBlank(row.cells)) {
      blankRows++;
      continue;
    }
    if (isNoteRow(row.cells, mapping.columns.sku)) {
      ignoredRows.push({ rowNumber: row.rowNumber, text: row.cells.find((c) => c.trim())!.trim().slice(0, 200) });
      continue;
    }
    const values: Record<string, string> = {};
    headers.forEach((header, i) => {
      values[header] = row.cells[i] ?? "";
    });
    rows.push({ rowNumber: row.rowNumber, values });
  }

  // Blank rows at the very end (common in Excel files) aren't worth reporting
  const lastDataRow = rows.at(-1)?.rowNumber ?? 0;
  const trailingBlank = grid.rows.filter((r) => r.rowNumber > lastDataRow && isBlank(r.cells)).length;
  blankRows -= trailingBlank;

  if (rows.length === 0) throw new ImportFileError("The sheet has a header row but no product rows");
  if (rows.length > MAX_ROWS) {
    throw new ImportFileError(
      `The sheet has ${rows.length.toLocaleString("en")} rows. The limit is ${MAX_ROWS.toLocaleString("en")} per import. Split it into smaller files`,
    );
  }

  const columns: Partial<Record<Field, string>> = {};
  for (const [field, index] of Object.entries(mapping.columns) as [Field, number][]) columns[field] = headers[index];

  return {
    headers,
    rows,
    info: {
      fileType: type,
      encoding: grid.encoding,
      delimiter: grid.delimiter,
      sheetName: grid.sheetName,
      headerRow: grid.rows[headerIndex].rowNumber,
      columns,
      unmappedColumns: mapping.unmapped.map((i) => headers[i]),
      hints: mapping.hints,
      blankRows,
      format: mapping.format,
      optionColumns: mapping.optionColumns.map((p) => ({ name: headers[p.name], value: headers[p.value] })),
      woo: mapping.format === "woocommerce" ? wooColumns(headers) : undefined,
      ignoredRows,
    },
  };
}
