import { and, eq, max, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { photos, products, variants } from "@/server/db/schema";

// A request the merchant can fix (unknown SKU, rejected photo...). The message is shown as is
export class AssignPhotoError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// Put it on the product that has this SKU (and on that variant), on a product as a whole, or take it off (null)
export type PhotoTarget = { sku: string } | { productId: string | null };

// The merchant decides where a photo goes, e.g. an unmatched "IMG_4533.jpg", or one that matching put on the
// wrong product. Marked as done by hand, so matching the import again never changes it back
export async function assignPhoto(db: Db, photoId: string, target: PhotoTarget) {
  return db.transaction(async (tx) => {
    const [photo] = await tx.select().from(photos).where(eq(photos.id, photoId)).for("update");
    if (!photo) throw new AssignPhotoError("Photo not found", 404);
    if (photo.status === "rejected") throw new AssignPhotoError(`This photo was rejected (${photo.reason}), so it can't be used`, 409);

    if ("productId" in target && target.productId === null) {
      await tx
        .update(photos)
        .set({ status: "unmatched", productId: null, variantId: null, productKey: null, sku: null, rowNumber: null, assignedByHand: true, reason: "Taken off its product by hand" })
        .where(eq(photos.id, photoId));
      return { id: photoId, status: "unmatched" as const, productId: null, productTitle: null, sku: null };
    }

    const findVariant = (where: ReturnType<typeof eq>) =>
      tx.select({ id: variants.id, sku: variants.sku, productId: variants.productId }).from(variants).where(where).limit(1);
    let variant: { id: string; sku: string; productId: string } | undefined;
    if ("sku" in target) {
      // Exactly as written first, then ignoring case ("tc-pl-30")
      const sku = target.sku.trim();
      [variant] = await findVariant(eq(variants.sku, sku));
      if (!variant) [variant] = await findVariant(sql`lower(${variants.sku}) = lower(${sku})`);
      if (!variant) throw new AssignPhotoError(`No product has SKU "${sku}"`, 404);
    }
    const productId = variant?.productId ?? (target as { productId: string }).productId;
    const [product] = await tx.select({ id: products.id, title: products.title, deletedAt: products.deletedAt }).from(products).where(eq(products.id, productId));
    if (!product) throw new AssignPhotoError("Product not found", 404);
    if (product.deletedAt) throw new AssignPhotoError("That product was deleted. Restore it first", 409);

    // At the end of the product's photos
    const [{ last }] = await tx.select({ last: max(photos.position) }).from(photos).where(and(eq(photos.productId, product.id), eq(photos.status, "matched")));
    await tx
      .update(photos)
      .set({
        status: "matched",
        productId: product.id,
        variantId: variant?.id ?? null,
        sku: variant?.sku ?? null,
        productKey: null,
        rowNumber: null,
        position: (last ?? -1) + 1,
        assignedByHand: true,
        reason: `Put on "${product.title}"${variant ? ` (SKU ${variant.sku})` : ""} by hand`,
      })
      .where(eq(photos.id, photoId));
    return { id: photoId, status: "matched" as const, productId: product.id, productTitle: product.title, sku: variant?.sku ?? null };
  });
}
