import Image from "next/image";
import Link from "next/link";
import { formatPrice } from "@/server/storefront/country";
import type { ShopCard } from "@/server/storefront/data";
import type { Shopper } from "../_lib/shopper";
import { shopHref } from "../_lib/shopper";

// Photos are already resized and saved as WebP when they're imported, so they're served as they are
// (unoptimized) from /api/photos/:id: the 400 px thumbnail here
export function ProductCard({ product, shopper }: { product: ShopCard; shopper: Shopper }) {
  const { text } = shopper;
  const price = product.price
    ? `${product.price.varies ? `${text.from} ` : ""}${formatPrice(product.price.cents, product.price.currency, shopper.locale)}`
    : text.priceOnRequest;
  return (
    <Link href={shopHref(`/shop/${product.handle}`, shopper)} className="group block rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4">
      <div className="aspect-square overflow-hidden rounded-2xl bg-stone-100 dark:bg-stone-900">
        {product.photo ? (
          <Image
            unoptimized
            src={`/api/photos/${product.photo.id}?size=thumb`}
            alt={product.title}
            width={product.photo.width ?? 400}
            height={product.photo.height ?? 400}
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-stone-400">{text.noPhoto}</div>
        )}
      </div>
      {product.category && <p className="mt-3 truncate text-xs uppercase tracking-wide text-stone-500">{product.category.split(" > ").at(-1)}</p>}
      <h3 className="mt-1 line-clamp-2 font-medium leading-snug group-hover:underline">{product.title}</h3>
      <p className="mt-1 text-sm text-stone-700 dark:text-stone-300">{price}</p>
    </Link>
  );
}
