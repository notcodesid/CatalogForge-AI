import { eq } from "drizzle-orm";
import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { photos } from "@/server/db/schema";
import { AssignPhotoError, assignPhoto } from "@/server/photos/assign";
import { readStoredFile } from "@/server/storage";
import { revalidateStorefront } from "@/server/storefront/revalidate";

const targetSchema = z.union([z.object({ sku: z.string().trim().min(1) }), z.object({ productId: z.uuid().nullable() })]);

// PATCH /api/photos/:id  { "sku": "TC-PL-30" } | { "productId": "<uuid>" } | { "productId": null }
// Puts the photo on the product with that SKU (and on that variant), on a product as a whole, or takes it off.
// Done by hand, so matching never changes it back
export async function PATCH(request: Request, ctx: RouteContext<"/api/photos/[id]">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Photo not found" }, { status: 404 });

  const body = targetSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: 'Send JSON: { "sku": "..." }, { "productId": "..." }, or { "productId": null } to take the photo off its product' }, { status: 400 });
  }
  try {
    const result = await assignPhoto(getDb(), id, body.data);
    // What shoppers see changed: the storefront shows it now instead of within a minute
    revalidateStorefront();
    return Response.json(result);
  } catch (err) {
    if (err instanceof AssignPhotoError) return Response.json({ error: err.message }, { status: err.status });
    console.error("[api] assigning a photo failed", err);
    return Response.json({ error: "Something went wrong. Try again" }, { status: 500 });
  }
}

// GET /api/photos/:id?size=thumb - a processed photo (WebP). The file is named after its content and never
// changes, so browsers and CDNs may keep it for a year
export async function GET(request: Request, ctx: RouteContext<"/api/photos/[id]">) {
  await connection();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Photo not found" }, { status: 404 });

  const [photo] = await getDb()
    .select({ storagePath: photos.storagePath, thumbnailPath: photos.thumbnailPath })
    .from(photos)
    .where(eq(photos.id, id));
  const key = new URL(request.url).searchParams.get("size") === "thumb" ? photo?.thumbnailPath : photo?.storagePath;
  if (!key) return Response.json({ error: "Photo not found, or not processed yet" }, { status: 404 });

  try {
    const bytes = await readStoredFile(key);
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable" },
    });
  } catch {
    return Response.json({ error: "Photo file missing" }, { status: 404 });
  }
}
