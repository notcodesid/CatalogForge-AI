import type { Locale } from "@/server/translations/fields";
import { absolute, decimalPrice, type ExportProduct, localized } from "./load";

// Shopify's product CSV (the columns of Shopify's own product template), so the catalog can be imported into a
// Shopify store as it is. Our own importer reads this file back too
export const SHOPIFY_COLUMNS = [
  "Handle",
  "Title",
  "Body (HTML)",
  "Vendor",
  "Product Category",
  "Type",
  "Tags",
  "Published",
  "Option1 Name",
  "Option1 Value",
  "Option1 Linked To",
  "Option2 Name",
  "Option2 Value",
  "Option2 Linked To",
  "Option3 Name",
  "Option3 Value",
  "Option3 Linked To",
  "Variant SKU",
  "Variant Grams",
  "Variant Inventory Tracker",
  "Variant Inventory Qty",
  "Variant Inventory Policy",
  "Variant Fulfillment Service",
  "Variant Price",
  "Variant Compare At Price",
  "Variant Requires Shipping",
  "Variant Taxable",
  "Unit Price Total Measure",
  "Unit Price Total Measure Unit",
  "Unit Price Base Measure",
  "Unit Price Base Measure Unit",
  "Variant Barcode",
  "Image Src",
  "Image Position",
  "Image Alt Text",
  "Gift Card",
  "SEO Title",
  "SEO Description",
  "Google Shopping / Google Product Category",
  "Google Shopping / Gender",
  "Google Shopping / Age Group",
  "Google Shopping / MPN",
  "Google Shopping / Condition",
  "Google Shopping / Custom Product",
  "Variant Image",
  "Variant Weight Unit",
  "Variant Tax Code",
  "Cost per item",
  "Status",
] as const;

export type ShopifyRow = Partial<Record<(typeof SHOPIFY_COLUMNS)[number], string>>;

// Shopify allows three options per product (e.g. Size, Colour, Material)
const MAX_OPTIONS = 3;
const OPTION_COLUMNS = [
  { name: "Option1 Name", value: "Option1 Value" },
  { name: "Option2 Name", value: "Option2 Value" },
  { name: "Option3 Name", value: "Option3 Value" },
] as const;

// Rows the way Shopify's own export writes them: the first row has the product's fields, every variant gets a row,
// and photos go on the rows in order, with a row of their own (handle and photo only) when there are more photos
// than variants. Options are named on the first row only. A product without options gets Shopify's
// "Title / Default Title". Approved products are published and active, the rest are drafts
export function toShopifyRows(item: ExportProduct, language: Locale | "en", origin: string, fallbackVendor = ""): ShopifyRow[] {
  const { product } = item;
  const view = localized(item, language);
  const options = view.options.slice(0, MAX_OPTIONS);
  const approved = product.status === "approved";
  const rows: ShopifyRow[] = [];

  for (let i = 0; i < Math.max(item.variants.length, item.photos.length, 1); i++) {
    const row: ShopifyRow = { Handle: product.handle };
    if (i === 0) {
      Object.assign(row, {
        Title: view.title,
        "Body (HTML)": view.descriptionHtml,
        Vendor: item.vendor ?? fallbackVendor,
        // Our categories aren't Shopify's product taxonomy, so they go in the free-text Type (its last part, e.g.
        // "Planters"); a category Shopify doesn't know could make its import refuse the product
        Type: view.category?.split(" > ").at(-1) ?? "",
        Tags: view.tags.join(", "),
        Published: approved ? "TRUE" : "FALSE",
        "Gift Card": "FALSE",
        "SEO Title": view.seo.metaTitle,
        "SEO Description": view.seo.metaDescription,
        Status: approved ? "active" : "draft",
      });
      if (options.length) options.forEach((o, k) => (row[OPTION_COLUMNS[k].name] = o.label));
      else row["Option1 Name"] = "Title";
    }

    const variant = item.variants[i];
    if (variant) {
      if (options.length) {
        options.forEach((o, k) => {
          const value = variant.options[o.name];
          if (value) row[OPTION_COLUMNS[k].value] = o.values[value] ?? value;
        });
      } else {
        row["Option1 Value"] = "Default Title";
      }
      const variantPhoto = item.photos.find((p) => p.sku === variant.sku);
      Object.assign(row, {
        "Variant SKU": variant.sku,
        "Variant Grams": variant.weightGrams === null ? "" : String(variant.weightGrams),
        "Variant Weight Unit": variant.weightGrams === null ? "" : variant.weightGrams >= 1000 ? "kg" : "g",
        // Supplier sheets don't give us stock levels, so Shopify isn't asked to track stock (no Inventory Tracker).
        // "deny" is Shopify's default policy, used once the merchant does track it
        "Variant Inventory Policy": "deny",
        "Variant Fulfillment Service": "manual",
        "Variant Price": decimalPrice(variant.priceCents),
        "Variant Requires Shipping": "TRUE",
        "Variant Taxable": "TRUE",
        "Variant Image": variantPhoto ? absolute(origin, variantPhoto.url) : "",
      });
    }

    const photo = item.photos[i];
    if (photo) {
      Object.assign(row, { "Image Src": absolute(origin, photo.url), "Image Position": String(i + 1), "Image Alt Text": view.title });
    }
    rows.push(row);
  }
  return rows;
}
