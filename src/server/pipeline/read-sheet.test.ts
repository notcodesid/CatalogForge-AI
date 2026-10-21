import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapColumns } from "./columns";
import { detectSheetType } from "./detect-file-type";
import { ImportFileError, readSheet } from "./read-sheet";

const encoder = new TextEncoder();

// Windows-1252 bytes, like a CSV saved by German Excel
function windows1252(text: string) {
  return Uint8Array.from([...text].map((c) => ({ ß: 0xdf, ü: 0xfc, ö: 0xf6, ä: 0xe4, "€": 0x80 })[c] ?? c.charCodeAt(0)));
}

describe("detectSheetType", () => {
  it("goes by the content, not the file name", () => {
    expect(detectSheetType(encoder.encode("%PDF-1.7"))).toMatchObject({ ok: false, reason: expect.stringContaining("PDF") });
    expect(detectSheetType(new Uint8Array())).toEqual({ ok: false, reason: "The file is empty" });
    expect(detectSheetType(readFileSync("samples/catalogforge_test_sheet.xlsx"))).toEqual({ ok: true, type: "xlsx" });
    expect(detectSheetType(encoder.encode("sku,name\n1,a"))).toEqual({ ok: true, type: "csv" });
  });
});

describe("mapColumns", () => {
  it("matches English, German and French headers and reads units from them", () => {
    const { columns, hints, unmapped } = mapColumns(["Artikelnummer", "Bezeichnung", "Preis (EUR)", "Gewicht in kg", "Couleur", "Supplier code 2"]);
    expect(columns).toEqual({ sku: 0, title: 1, price: 2, weight: 3, color: 4 });
    expect(hints).toEqual({ priceCurrency: "EUR", weightUnit: "kg" });
    expect(unmapped).toEqual([5]);
  });

  it("keeps a second column for the same field as extra text", () => {
    expect(mapColumns(["SKU", "Description", "Long description"]).unmapped).toEqual([2]);
  });
});

describe("readSheet", () => {
  it("reads the sample CSV and skips the blank row", () => {
    const sheet = readSheet(readFileSync("samples/catalogforge_test_sheet.csv"), "csv");
    expect(sheet.rows).toHaveLength(18);
    expect(sheet.info.blankRows).toBe(1);
    expect(sheet.rows[0].rowNumber).toBe(2);
    // Row 12 is blank, so the next stored row keeps its real sheet number
    expect(sheet.rows[10].rowNumber).toBe(13);
  });

  it("gives the same rows for the sample XLSX as for the CSV", () => {
    const csv = readSheet(readFileSync("samples/catalogforge_test_sheet.csv"), "csv");
    const xlsx = readSheet(readFileSync("samples/catalogforge_test_sheet.xlsx"), "xlsx");
    expect(xlsx.rows).toEqual(csv.rows);
    expect(xlsx.info.sheetName).toBe("Products");
  });

  it("reads a German Excel CSV: Windows-1252, semicolons, a title row above the header", () => {
    const bytes = windows1252("Lieferantenliste Herbst;;\nArtikelnummer;Bezeichnung;Preis\nAB-1;Gießkanne;12,90 €\n");
    const sheet = readSheet(bytes, "csv");
    expect(sheet.info).toMatchObject({ encoding: "windows-1252", delimiter: ";", headerRow: 2 });
    expect(sheet.rows).toEqual([{ rowNumber: 3, values: { Artikelnummer: "AB-1", Bezeichnung: "Gießkanne", Preis: "12,90 €" } }]);
  });

  it("copes with mixed Windows and Unix line endings", () => {
    const sheet = readSheet(encoder.encode("SKU,Name\r\nA-1,One\nA-2,Two\r\nA-3,Three\n"), "csv");
    expect(sheet.rows.map((r) => r.values.SKU)).toEqual(["A-1", "A-2", "A-3"]);
  });

  it("keeps line breaks inside quoted cells", () => {
    const sheet = readSheet(encoder.encode('SKU,Description\nA-1,"Line one\nLine two"\n'), "csv");
    expect(sheet.rows[0].values.Description).toBe("Line one\nLine two");
  });

  it.each([
    ["foo,bar\n1,2\n", "Couldn't find the header row"],
    ["SKU,Name\n", "no product rows"],
    ["\n\n", "no data"],
  ])("fails with a clear message: %j", (text, message) => {
    expect(() => readSheet(encoder.encode(text), "csv")).toThrow(ImportFileError);
    expect(() => readSheet(encoder.encode(text), "csv")).toThrow(message);
  });

  it("ignores footers, notes and section titles, and says which rows it ignored", () => {
    const sheet = readSheet(readFileSync("samples/test-files/03-messy-layout/supplier_price_list_2026.xlsx"), "xlsx");
    expect(sheet.info.sheetName).toBe("Products");
    expect(sheet.info.headerRow).toBe(4);
    expect(sheet.rows.map((r) => r.values.SKU)).not.toContain("Prices subject to change. E&OE.");
    expect(sheet.info.ignoredRows).toEqual([{ rowNumber: 15, text: "Prices subject to change. E&OE." }]);
  });

  it("keeps a row that has only a SKU (a product with everything else missing goes to review)", () => {
    const sheet = readSheet(encoder.encode("SKU,Name,Price\nA-1,Mug,5\nA-2,,\nGarden tools,,\n"), "csv");
    expect(sheet.rows.map((r) => r.values.SKU)).toEqual(["A-1", "A-2"]);
    expect(sheet.info.ignoredRows).toEqual([{ rowNumber: 4, text: "Garden tools" }]);
  });

  it("refuses more than 10,000 rows", () => {
    const text = "SKU,Name\n" + Array.from({ length: 10_001 }, (_, i) => `S-${i},Item ${i}`).join("\n");
    expect(() => readSheet(encoder.encode(text), "csv")).toThrow("The limit is 10,000 per import");
  });
});
