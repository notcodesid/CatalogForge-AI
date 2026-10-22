import { describe, expect, it } from "vitest";
import { matchPhotos, photoKey, type RowForPhotos } from "./match";

describe("photoKey", () => {
  it("ignores folders, extensions, case, copy numbers and separators", () => {
    expect(photoKey("photos/TC-PL-30 (1).JPG")).toBe("tc-pl-30");
    expect(photoKey("TC_PL_30.jpeg")).toBe("tc-pl-30");
    expect(photoKey("IMG_4532.jpg")).toBe("img-4532");
    expect(photoKey("https://cdn.example.com/files/linen%20cushion.jpg?v=2")).toBe("linen-cushion");
  });
});

describe("matchPhotos", () => {
  // Like the sample sheet: the planter's rows name their photos, the hanging basket names a camera file
  const rows: RowForPhotos[] = [
    { rowNumber: 2, productKey: "parent:tc-pl", sku: "TC-PL-20", parentSku: "TC-PL", image: "TC-PL-20.jpg" },
    { rowNumber: 3, productKey: "parent:tc-pl", sku: "TC-PL-30", parentSku: "TC-PL", image: "tc-pl-30.JPG" },
    { rowNumber: 4, productKey: "sku:mg-01", sku: "MG-01", parentSku: null, image: "MG-01.jpg" },
    { rowNumber: 10, productKey: "parent:hb-pl", sku: "HB-PL-8", parentSku: "HB-PL", image: "IMG_4532.jpg" },
    { rowNumber: 20, productKey: "parent:tc-pl", sku: "TC-PL-40", parentSku: "TC-PL", image: "https://cdn.example.com/TC-PL-40.jpg" },
    { rowNumber: 21, productKey: "sku:wc-01", sku: "WC-01", parentSku: null, image: null },
  ];
  const photo = (fileName: string) => ({ id: fileName, fileName, status: "pending" });
  const photos = ["TC-PL-20.jpg", "TC-PL-30.jpg", "tc-pl-30 (1).JPG", "IMG_4532.jpg", "IMG_4533.jpg", "UT-15.jpg", "HB-PL.jpg", "wc-01.png", "TC-PL-40.jpg"].map(photo);
  const catalog = [{ sku: "UT-15", productId: "p-ut", variantId: "v-ut-15" }];
  const { matches, missing } = matchPhotos({ photos, rows, catalog, imageColumn: "Image" });
  const match = (id: string) => matches.find((m) => m.id === id)!;

  it("uses the photo a row names, even when the file name isn't a SKU", () => {
    expect(match("IMG_4532.jpg")).toMatchObject({ status: "matched", productKey: "parent:hb-pl", sku: "HB-PL-8", rowNumber: 10, reason: "Row 10 names this file in column Image" });
    // A link in the image column counts too
    expect(match("TC-PL-40.jpg")).toMatchObject({ status: "matched", productKey: "parent:tc-pl", sku: "TC-PL-40" });
  });

  it("matches a file named after a SKU, whatever the case, and a copy of it", () => {
    expect(match("TC-PL-30.jpg")).toMatchObject({ status: "matched", productKey: "parent:tc-pl", sku: "TC-PL-30" });
    expect(match("tc-pl-30 (1).JPG")).toMatchObject({ status: "matched", productKey: "parent:tc-pl", sku: "TC-PL-30" });
    expect(match("wc-01.png")).toMatchObject({ status: "matched", productKey: "sku:wc-01", reason: "The file name is SKU WC-01 (row 21)" });
  });

  it("matches a parent SKU to the whole product, and a SKU from an earlier import to that product", () => {
    expect(match("HB-PL.jpg")).toMatchObject({ status: "matched", productKey: "parent:hb-pl", sku: null });
    expect(match("UT-15.jpg")).toMatchObject({ status: "matched", productId: "p-ut", variantId: "v-ut-15", reason: "The file name is SKU UT-15, a product already in the catalog" });
  });

  it("leaves a photo it can't place unmatched, with the reason", () => {
    expect(match("IMG_4533.jpg")).toMatchObject({ status: "unmatched", reason: "No product in this sheet or the catalog has this SKU, and no row names this file" });
  });

  it("orders a product's photos by row", () => {
    const planter = matches.filter((m) => m.productKey === "parent:tc-pl").sort((a, b) => a.position - b.position);
    expect(planter.map((m) => m.rowNumber)).toEqual([2, 3, 3, 20]);
  });

  it("lists photos the sheet names that weren't uploaded, but not links", () => {
    expect(missing).toEqual([{ file: "MG-01.jpg", rows: [4] }]);
  });

  it("won't guess when rows of two different products name the same file", () => {
    const shared = matchPhotos({
      photos: [photo("shared.jpg")],
      rows: [
        { rowNumber: 2, productKey: "a", sku: "A", parentSku: null, image: "shared.jpg" },
        { rowNumber: 5, productKey: "b", sku: "B", parentSku: null, image: "shared.jpg" },
      ],
      catalog: [],
    });
    expect(shared.matches[0]).toMatchObject({ status: "unmatched", reason: "Rows 2 and 5 name this file, but they're different products" });
  });

  it("doesn't complain about missing photos when none were uploaded", () => {
    expect(matchPhotos({ photos: [], rows, catalog: [] }).missing).toEqual([]);
  });
});

describe("matchPhotos: links in the sheet", () => {
  const rows: RowForPhotos[] = [
    { rowNumber: 2, productKey: "parent:lcc", sku: "LCC-SAGE-45", parentSku: "LCC", image: "https://cdn.example.com/lcc-sage.jpg" },
    { rowNumber: 3, productKey: "parent:lcc", sku: "LCC-SAGE-50", parentSku: "LCC", image: null },
    // A Shopify image row: no SKU, just one more photo of the product
    { rowNumber: 4, productKey: "parent:lcc", sku: null, parentSku: "LCC", image: "https://cdn.example.com/lcc-detail.jpg" },
    { rowNumber: 5, productKey: "sku:wc-en-2", sku: "WC-EN-2", parentSku: null, image: "https://cdn.example.com/wc-en-2.jpg" },
    { rowNumber: 6, productKey: "sku:t-1", sku: "T-1", parentSku: null, image: "https://shop.example.com/tray.jpg, https://shop.example.com/tray-lid.jpg" },
  ];
  // The merchant uploaded wc-en-2.jpg themselves
  const uploads = [{ id: "upload", fileName: "WC-EN-2.jpg", status: "pending" }];

  it("turns each link into a photo of its row's product, but uses an uploaded copy instead of downloading it", () => {
    const { matches, links, linksOverLimit } = matchPhotos({ photos: uploads, rows, catalog: [], imageColumn: "Image Src" });
    expect(links).toEqual([
      { url: "https://cdn.example.com/lcc-sage.jpg", status: "matched", productKey: "parent:lcc", sku: "LCC-SAGE-45", rowNumber: 2, position: 0, reason: "The link in row 2 in column Image Src" },
      { url: "https://cdn.example.com/lcc-detail.jpg", status: "matched", productKey: "parent:lcc", sku: null, rowNumber: 4, position: 1, reason: "The link in row 4 in column Image Src" },
      { url: "https://shop.example.com/tray.jpg", status: "matched", productKey: "sku:t-1", sku: "T-1", rowNumber: 6, position: 0, reason: "The link in row 6 in column Image Src" },
      { url: "https://shop.example.com/tray-lid.jpg", status: "matched", productKey: "sku:t-1", sku: "T-1", rowNumber: 6, position: 1, reason: "The link in row 6 in column Image Src" },
    ]);
    expect(linksOverLimit).toBe(0);
    expect(matches).toMatchObject([{ id: "upload", status: "matched", productKey: "sku:wc-en-2", reason: "Row 5 names this file in column Image Src" }]);
  });

  it("stops at the photo limit and counts the links it left out", () => {
    const { links, linksOverLimit } = matchPhotos({ photos: [], rows, catalog: [], maxLinks: 2 });
    expect(links.map((l) => l.url)).toEqual(["https://cdn.example.com/lcc-sage.jpg", "https://cdn.example.com/lcc-detail.jpg"]);
    expect(linksOverLimit).toBe(3);
  });
});
