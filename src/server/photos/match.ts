import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { importRows, photos, products, variants } from "@/server/db/schema";
import type { CleanedRow } from "@/server/pipeline/types";
import { MAX_PHOTOS_PER_IMPORT } from "./upload";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Lowercase, with anything that isn't a letter or digit as one "-": "TC_PL_20", "tc-pl-20" and "TC PL 20" match
function toKey(text: string) {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

// The part of a photo's name that can match a SKU or the sheet: "photos/TC-PL-30 (1).JPG" -> "tc-pl-30".
// Works for URLs too ("https://cdn.example.com/p/tc-pl-30.jpg?v=2")
export function photoKey(fileName: string) {
  let base = path.posix.basename(fileName.replace(/\\/g, "/").replace(/[?#].*$/, ""));
  try {
    base = decodeURIComponent(base);
  } catch {
    // Not URL-encoded after all
  }
  // Without the extension, and without the " (1)" a computer adds to a copy
  return toKey(base.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/\s*\(\d+\)$/, ""));
}

const skuKey = (sku: string) => toKey(sku);

// An image cell can hold several names or links: "a.jpg, b.jpg"
function imageNames(cell: string | null): string[] {
  return (cell ?? "")
    .split(/[,;\n|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const isLink = (name: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(name);

export type PhotoToMatch = { id: string; fileName: string; status: string };
export type RowForPhotos = { rowNumber: number; productKey: string; sku: string | null; parentSku: string | null; image: string | null };
export type CatalogVariant = { sku: string; productId: string; variantId: string };

export type PhotoMatch = {
  id: string;
  status: "matched" | "unmatched";
  reason: string;
  productKey: string | null;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  rowNumber: number | null;
  position: number;
};

export type MissingPhoto = { file: string; rows: number[] };

function index<T>(items: T[], keysOf: (item: T) => string[]) {
  const map = new Map<string, T[]>();
  for (const item of items) for (const key of keysOf(item)) if (key) map.set(key, [...(map.get(key) ?? []), item]);
  return map;
}

const listRows = (rows: RowForPhotos[]) => {
  const numbers = [...new Set(rows.map((r) => r.rowNumber))];
  return numbers.length === 1 ? `Row ${numbers[0]}` : `Rows ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
};

// A photo to download from a link in the sheet, already matched to the product of the row(s) with the link
export type LinkPhoto = {
  url: string;
  status: "matched" | "unmatched";
  reason: string;
  productKey: string | null;
  sku: string | null;
  rowNumber: number | null;
  position: number;
};

// Decides which product each photo belongs to, in this order:
// 1. a row of the sheet names the file (its image column), 2. the file name is the SKU of a row,
// 3. the file name is a product's parent SKU, 4. the file name is the SKU of a product already in the catalog.
// Anything else is unmatched, with the reason. Links in the image column (https://...) become photos to
// download, unless the same file was uploaded; at most maxLinks of them. Also lists the files the sheet names
// that weren't uploaded
export function matchPhotos(input: {
  photos: PhotoToMatch[];
  rows: RowForPhotos[];
  catalog: CatalogVariant[];
  imageColumn?: string;
  maxLinks?: number;
}): { matches: PhotoMatch[]; links: LinkPhoto[]; linksOverLimit: number; missing: MissingPhoto[] } {
  const byImage = index(input.rows, (r) => imageNames(r.image).map(photoKey));
  const bySku = index(input.rows, (r) => (r.sku ? [skuKey(r.sku)] : []));
  const byParent = index(input.rows, (r) => (r.parentSku ? [skuKey(r.parentSku)] : []));
  const catalog = new Map(input.catalog.map((v) => [skuKey(v.sku), v]));
  const column = input.imageColumn ? ` in column ${input.imageColumn}` : "";
  const none = { productKey: null, productId: null, variantId: null, sku: null, rowNumber: null, position: 0 };

  // Rows that point at a photo. They must all be the same product, or we can't tell which one it is
  const fromRows = (rows: RowForPhotos[], sku: string | null, matched: (row: number) => string, conflict: string) => {
    if (new Set(rows.map((r) => r.productKey)).size > 1) {
      return { ...none, status: "unmatched" as const, reason: `${listRows(rows)} ${conflict}, but they're different products` };
    }
    const first = [...rows].sort((a, b) => a.rowNumber - b.rowNumber)[0];
    return { ...none, status: "matched" as const, productKey: first.productKey, sku, rowNumber: first.rowNumber, reason: matched(first.rowNumber) };
  };
  const onlySku = (rows: RowForPhotos[]) => {
    const skus = new Set(rows.map((r) => r.sku));
    return skus.size === 1 ? [...skus][0] : null;
  };

  const matches: PhotoMatch[] = [];
  for (const photo of input.photos) {
    if (photo.status === "rejected") continue;
    const key = photoKey(photo.fileName);
    const named = byImage.get(key);
    const skuRows = bySku.get(key);
    const parentRows = byParent.get(key);
    const known = catalog.get(key);
    if (named) {
      matches.push({ id: photo.id, ...fromRows(named, onlySku(named), (n) => `Row ${n} names this file${column}`, "name this file") });
    } else if (skuRows) {
      const sku = skuRows[0].sku!;
      matches.push({ id: photo.id, ...fromRows(skuRows, sku, (n) => `The file name is SKU ${sku} (row ${n})`, `have SKU ${sku}`) });
    } else if (parentRows) {
      const parent = parentRows[0].parentSku!;
      matches.push({ id: photo.id, ...fromRows(parentRows, null, (n) => `The file name is the parent SKU ${parent} (row ${n})`, `have parent SKU ${parent}`) });
    } else if (known) {
      matches.push({
        ...none,
        id: photo.id,
        status: "matched",
        productId: known.productId,
        variantId: known.variantId,
        sku: known.sku,
        reason: `The file name is SKU ${known.sku}, a product already in the catalog`,
      });
    } else {
      matches.push({ ...none, id: photo.id, status: "unmatched", reason: "No product in this sheet or the catalog has this SKU, and no row names this file" });
    }
  }

  // Links, in sheet order. A link whose file the merchant also uploaded isn't downloaded: the upload is used
  const uploaded = new Set(input.photos.filter((p) => p.status !== "rejected").map((p) => photoKey(p.fileName)));
  const linkRows = new Map<string, RowForPhotos[]>();
  for (const row of [...input.rows].sort((a, b) => a.rowNumber - b.rowNumber)) {
    for (const name of imageNames(row.image)) {
      if (!isLink(name) || uploaded.has(photoKey(name))) continue;
      linkRows.set(name, [...(linkRows.get(name) ?? []), row]);
    }
  }
  const maxLinks = input.maxLinks ?? Number.POSITIVE_INFINITY;
  const links: LinkPhoto[] = [...linkRows].slice(0, maxLinks).map(([url, rows]) => {
    const m = fromRows(rows, onlySku(rows), (n) => `The link in row ${n}${column}`, "link to this photo");
    return { url, status: m.status, reason: m.reason, productKey: m.productKey, sku: m.sku, rowNumber: m.rowNumber, position: 0 };
  });

  // The order of a product's photos, uploads and links together: by the row they belong to, the original before
  // its copies ("x (1).jpg"), links in the order the sheet lists them, then by name
  const names = new Map(input.photos.map((p) => [p.id, p.fileName]));
  const ordered = [
    ...matches.filter((m) => m.status === "matched").map((m) => ({ item: m, group: m.productKey ?? `id:${m.productId}`, name: names.get(m.id)!, seq: 0 })),
    ...links.map((l, seq) => ({ item: l, group: l.productKey, name: l.url, seq })).filter((o) => o.item.status === "matched"),
  ];
  const isCopy = (name: string) => (/\s*\(\d+\)\.[^.]+$/.test(name) ? 1 : 0);
  for (const group of index(ordered, (o) => [o.group ?? ""]).values()) {
    group.sort(
      (a, b) =>
        (a.item.rowNumber ?? Number.MAX_SAFE_INTEGER) - (b.item.rowNumber ?? Number.MAX_SAFE_INTEGER) ||
        isCopy(a.name) - isCopy(b.name) ||
        a.seq - b.seq ||
        a.name.localeCompare(b.name),
    );
    group.forEach((o, position) => (o.item.position = position));
  }

  // Files the sheet names that nobody uploaded. Only worth saying when photos were uploaded at all. Links aren't
  // listed: they're downloaded instead
  const missing = new Map<string, MissingPhoto>();
  if (input.photos.length) {
    const uploadedNames = new Set(input.photos.map((p) => photoKey(p.fileName)));
    for (const row of input.rows) {
      for (const name of imageNames(row.image)) {
        if (isLink(name) || uploadedNames.has(photoKey(name))) continue;
        const entry = missing.get(name) ?? { file: name, rows: [] };
        if (!entry.rows.includes(row.rowNumber)) entry.rows.push(row.rowNumber);
        missing.set(name, entry);
      }
    }
  }
  return { matches, links, linksOverLimit: Math.max(0, linkRows.size - maxLinks), missing: [...missing.values()] };
}

// Works out every photo's product for an import, from its rows and the catalog. Nothing is written
export async function planPhotoMatches(db: DbOrTx, importId: string, imageColumn?: string) {
  // Uploaded photos only: photos from links were matched when they were created
  const uploaded = await db
    .select({ id: photos.id, fileName: photos.fileName, status: photos.status })
    .from(photos)
    .where(and(eq(photos.importId, importId), isNull(photos.sourceUrl)));

  const rows = (
    await db
      .select({ rowNumber: importRows.rowNumber, productKey: importRows.productKey, cleaned: importRows.cleaned })
      .from(importRows)
      .where(and(eq(importRows.importId, importId), ne(importRows.status, "failed"), isNotNull(importRows.productKey)))
  ).map((r) => {
    const c = r.cleaned as CleanedRow;
    return { rowNumber: r.rowNumber, productKey: r.productKey!, sku: c.sku, parentSku: c.parentSku, image: c.image };
  });

  // Photos named like a SKU that isn't in this sheet: maybe a product imported earlier
  const inSheet = new Set(rows.flatMap((r) => [r.sku, r.parentSku].filter((s): s is string => Boolean(s)).map(skuKey)));
  const candidates = [...new Set(uploaded.map((p) => photoKey(p.fileName)))].filter((k) => k && !inSheet.has(k));
  const catalog: CatalogVariant[] = [];
  for (let i = 0; i < candidates.length; i += 1000) {
    const keys = candidates.slice(i, i + 1000);
    const found = await db
      .select({ sku: variants.sku, productId: variants.productId, variantId: variants.id })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(
        and(
          isNull(products.deletedAt),
          or(
            inArray(sql`lower(${variants.sku})`, keys),
            inArray(sql`trim(both '-' from regexp_replace(lower(${variants.sku}), '[^a-z0-9]+', '-', 'g'))`, keys),
          ),
        ),
      );
    catalog.push(...found.filter((v) => keys.includes(skuKey(v.sku))));
  }

  // Links share the import's photo limit with the uploads
  const maxLinks = Math.max(0, MAX_PHOTOS_PER_IMPORT - uploaded.filter((p) => p.status !== "rejected").length);
  return matchPhotos({ photos: uploaded, rows, catalog, imageColumn, maxLinks });
}

// Creates the photos to download from the sheet's links. Running it again (a retry) adds nothing new.
// Returns the ids of the photos it created, so they can be queued for downloading
export async function saveLinkPhotos(tx: DbOrTx, importId: string, links: LinkPhoto[]) {
  const ids: string[] = [];
  for (let i = 0; i < links.length; i += 1000) {
    const created = await tx
      .insert(photos)
      .values(
        links.slice(i, i + 1000).map((l) => ({
          importId,
          fileName: l.url,
          sourceUrl: l.url,
          status: l.status,
          reason: l.reason,
          productKey: l.productKey,
          sku: l.sku,
          rowNumber: l.rowNumber,
          position: l.position,
        })),
      )
      .onConflictDoNothing({ target: [photos.importId, photos.fileName] })
      .returning({ id: photos.id });
    ids.push(...created.map((c) => c.id));
  }
  return ids;
}

// Writes the matches. A photo rejected meanwhile (broken file) stays rejected, and one the merchant placed by hand
// stays where they put it
export async function saveMatches(tx: DbOrTx, matches: PhotoMatch[]) {
  for (const m of matches) {
    const { id, ...fields } = m;
    await tx.update(photos).set(fields).where(and(eq(photos.id, id), ne(photos.status, "rejected"), eq(photos.assignedByHand, false)));
  }
}

// Once a product is saved, the photos matched to it in this import get its id, and the id of the variant their
// SKU belongs to. Without a productId, photos of every product of the import whose key matches are linked
export async function linkPhotos(db: DbOrTx, importId: string, target: { productKey: string; productId: string } | "all") {
  if (target === "all") {
    await db.execute(sql`
      update ${photos} p set product_id = pr.id,
        variant_id = (select v.id from ${variants} v where v.product_id = pr.id and v.sku = p.sku)
      from ${products} pr
      where p.import_id = ${importId} and p.status = 'matched' and p.product_id is null and pr.product_key = p.product_key
    `);
    return;
  }
  await db.execute(sql`
    update ${photos} p set product_id = ${target.productId},
      variant_id = (select v.id from ${variants} v where v.product_id = ${target.productId} and v.sku = p.sku)
    where p.import_id = ${importId} and p.status = 'matched' and p.product_key = ${target.productKey}
  `);
}
