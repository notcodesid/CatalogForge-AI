import type { Metadata } from "next";
import Link from "next/link";
import { shopCategories, shopPage } from "@/server/storefront/cached";
import { translateCategory } from "@/server/translations/categories";
import { ProductCard } from "./_components/product-card";
import { RememberCountry } from "./_components/remember-country";
import { ShopHeader } from "./_components/shop-header";
import { type SearchParams, shopHref, type Shopper, shopperContext } from "./_lib/shopper";

// Rendered per request from cached data, so the shopper's country decides the language (see ../layout.tsx).
// Each page opts out of the instant-navigation check itself; the layout's opt-out covers the static shell
export const instant = false;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only a category the shop really has (or a level above one, like "Home & Garden") is used from the link
async function pickCategory(shopper: Shopper, searchParams: SearchParams) {
  const wanted = first(searchParams.category)?.trim();
  if (!wanted) return { category: null, categories: await shopCategories(shopper.language) };
  const categories = await shopCategories(shopper.language);
  const known = categories.some((c) => c.value === wanted || c.value.startsWith(`${wanted} > `));
  return { category: known ? wanted : null, categories };
}

export async function generateMetadata(props: PageProps<"/shop">): Promise<Metadata> {
  const shopper = await shopperContext(await props.searchParams);
  const languages = Object.fromEntries(shopper.countries.filter((c) => c.enabled).map((c) => [`${c.language}-${c.country}`, `/shop?country=${c.country}`]));
  return {
    metadataBase: new URL(shopper.baseUrl),
    // The shop's own name, not the dashboard's title template
    title: { absolute: shopper.text.shopName },
    description: shopper.text.metaDescription,
    alternates: { canonical: shopper.countryParam ? `/shop?country=${shopper.countryParam}` : "/shop", languages: { ...languages, "x-default": "/shop" } },
  };
}

export default async function ShopPage(props: PageProps<"/shop">) {
  const searchParams = await props.searchParams;
  const shopper = await shopperContext(searchParams);
  const { category, categories } = await pickCategory(shopper, searchParams);
  const requestedPage = Number.parseInt(first(searchParams.page) ?? "1", 10);
  const result = await shopPage(shopper.language, category, Number.isFinite(requestedPage) ? requestedPage : 1);
  const { text } = shopper;
  const heading = category ? (translateCategory(category, shopper.language) ?? category).split(" > ").at(-1) : text.allProducts;
  const chip = (active: boolean) =>
    `shrink-0 rounded-full border px-3 py-1.5 text-sm transition ${active ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900" : "border-stone-300 hover:border-stone-900 dark:border-stone-700 dark:hover:border-stone-100"}`;

  return (
    <div lang={shopper.language} className="flex flex-1 flex-col">
      <ShopHeader shopper={shopper} switchHref={(country) => `/shop?${new URLSearchParams({ ...(category ? { category } : {}), country })}`} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{heading}</h1>
          <p className="text-sm text-stone-500">{text.productCount(result.total)}</p>
        </div>

        {categories.length > 1 && (
          <nav aria-label={text.allProducts} className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-2 sm:mx-0 sm:flex-wrap sm:px-0">
            <Link href={shopHref("/shop", shopper)} className={chip(!category)}>
              {text.allProducts}
            </Link>
            {categories.map((c) => (
              <Link key={c.value} href={shopHref("/shop", shopper, { category: c.value })} title={c.label} className={chip(c.value === category)}>
                {c.label.split(" > ").at(-1)} <span className="opacity-60">{c.products}</span>
              </Link>
            ))}
          </nav>
        )}

        {result.products.length ? (
          <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            {result.products.map((product) => (
              <li key={product.handle}>
                <ProductCard product={product} shopper={shopper} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-16 text-center text-stone-500">{text.noProducts}</p>
        )}

        {result.pageCount > 1 && (
          <nav aria-label={text.pageOf(result.page, result.pageCount)} className="mt-10 flex items-center justify-between gap-4 text-sm">
            {result.page > 1 ? (
              <Link href={shopHref("/shop", shopper, { category, page: result.page - 1 })} className="rounded-full border border-stone-300 px-4 py-2 hover:border-stone-900 dark:border-stone-700">
                ← {text.previous}
              </Link>
            ) : (
              <span />
            )}
            <span className="text-stone-500">{text.pageOf(result.page, result.pageCount)}</span>
            {result.page < result.pageCount ? (
              <Link href={shopHref("/shop", shopper, { category, page: result.page + 1 })} className="rounded-full border border-stone-300 px-4 py-2 hover:border-stone-900 dark:border-stone-700">
                {text.next} →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </main>
      <RememberCountry country={shopper.countryParam} />
    </div>
  );
}
