import type { RowInput } from "./clean/row";
import type { Field, ParseInfo } from "./types";

// Fields that are the same for every size/colour of a product. Shopify only fills them on a product's
// first row, and many suppliers do the same, so variant rows that leave them empty get them from their
// product's other rows
const SHARED_FIELDS: Field[] = ["title", "description", "brand", "category", "material"];

// Turns raw sheet rows into cleaning input, looking across the whole sheet first: links WooCommerce
// variations to their parent, spots photo-only rows, and fills shared product info down into variants
export function prepareRows(raws: Record<string, string>[], info: ParseInfo): RowInput[] {
  const inputs = raws.map((raw) => toRowInput(raw, info));
  if (info.woo) linkWooParents(raws, inputs, info.woo);
  markPhotoRows(inputs);
  fillDownWithinProducts(inputs);
  return inputs;
}

function toRowInput(raw: Record<string, string>, info: ParseInfo): RowInput {
  const fields: Partial<Record<Field, string>> = {};
  for (const [field, header] of Object.entries(info.columns) as [Field, string][]) fields[field] = raw[header];
  const extra: Record<string, string> = {};
  for (const header of info.unmappedColumns) extra[header] = raw[header] ?? "";
  const options = info.optionColumns.map((pair) => ({ name: raw[pair.name] ?? "", value: raw[pair.value] ?? "" }));
  return { fields, extra, options, role: "variant" };
}

const filled = (value: string | undefined): value is string => Boolean(value?.trim());

// WooCommerce: a "variable" row is the product (shared info, no price of its own) and its "variation" rows
// point to it with Parent = "id:101". Turn that into a normal parent SKU so they group together
function linkWooParents(raws: Record<string, string>[], inputs: RowInput[], woo: NonNullable<ParseInfo["woo"]>) {
  const keyById = new Map<string, string>();
  raws.forEach((raw, i) => {
    const id = raw[woo.idColumn]?.trim();
    if (id) keyById.set(id, inputs[i].fields.sku?.trim() || `id:${id}`);
  });

  raws.forEach((raw, i) => {
    const input = inputs[i];
    const parentRef = input.fields.parentSku?.trim().match(/^id:(\d+)$/i);
    if (parentRef) input.fields.parentSku = keyById.get(parentRef[1]) ?? input.fields.parentSku;

    if (raw[woo.typeColumn]?.trim().toLowerCase() === "variable") {
      input.role = "product";
      input.fields.parentSku = keyById.get(raw[woo.idColumn]?.trim()) ?? input.fields.sku;
    }
  });
}

// A row that only adds a picture to a product (Shopify lists extra photos this way): no SKU, no price,
// no name, no options, just a parent and an image
function markPhotoRows(inputs: RowInput[]) {
  for (const input of inputs) {
    const f = input.fields;
    const hasOptions = input.options.some((o) => filled(o.value));
    if (filled(f.parentSku) && filled(f.image) && !filled(f.sku) && !filled(f.price) && !filled(f.title) && !hasOptions) {
      input.role = "image";
    }
  }
}

function fillDownWithinProducts(inputs: RowInput[]) {
  const groups = new Map<string, RowInput[]>();
  for (const input of inputs) {
    const parent = input.fields.parentSku?.trim().toLowerCase();
    if (!parent) continue;
    groups.set(parent, [...(groups.get(parent) ?? []), input]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // The product row (WooCommerce) knows best, otherwise the first row that has the value
    const ordered = [...group.filter((r) => r.role === "product"), ...group.filter((r) => r.role !== "product")];

    for (const field of SHARED_FIELDS) {
      const source = ordered.find((r) => filled(r.fields[field]))?.fields[field];
      if (!source) continue;
      for (const row of group) if (!filled(row.fields[field])) row.fields[field] = source;
    }

    // Option names ("Size", "Color") are also only on the first row in Shopify
    const optionCount = Math.max(...group.map((r) => r.options.length));
    for (let k = 0; k < optionCount; k++) {
      const name = ordered.find((r) => filled(r.options[k]?.name))?.options[k].name;
      if (!name) continue;
      for (const row of group) if (row.options[k] && !filled(row.options[k].name)) row.options[k].name = name;
    }
  }
}
