import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { shopProduct } from "@/server/storefront/cached";
import { formatPrice } from "@/server/storefront/country";
import { PhotoGallery } from "../_components/photo-gallery";
import { RememberCountry } from "../_components/remember-country";
import { ShopHeader } from "../_components/shop-header";
import { VariantPicker } from "../_components/variant-picker";
import { shopHref, shopperContext } from "../_lib/shopper";

// Rendered per request from cached data: the shopper's country decides the language (see ../layout.tsx). Each
// page opts out of the instant-navigation check itself
export const instant = false;

// A product that doesn't exist, isn't approved or was deleted must answer with a real 404. By default the build
// makes one shared shell for every handle, and the production server sends it with a 200 before this page runs,
// so a 404 found afterwards can only show the not-found page. "blocking" turns that shell off: the first request
// for a handle waits for the page's own product check (in load below), and Next.js keeps the answer, the 404
// included, until the storefront's cached data is refreshed. Not in the Next.js docs yet (hence "unstable_"): if
// an upgrade drops it, product pages still work but unknown ones go back to a 200
export const unstable_paramMatching = { handle: "blocking" };

async function load(props: PageProps<"/shop/[handle]">) {
  const { handle } = await props.params;
  // Before the shopper's cookies and headers are read: whether a product is on sale is the same for everyone, so
  // this check is part of what Next.js renders once per handle and keeps. English is every product's own text and
  // what most shoppers read, so this is usually the same cached read as the one below
  if (!(await shopProduct(handle, "en"))) notFound();
  const shopper = await shopperContext(await props.searchParams);
  return { handle, shopper, product: await shopProduct(handle, shopper.language) };
}

export async function generateMetadata(props: PageProps<"/shop/[handle]">): Promise<Metadata> {
  const { handle, shopper, product } = await load(props);
  if (!product) return { title: { absolute: shopper.text.shopName }, robots: { index: false } };
  // One address per language for search engines: each country the shop serves in its own language
  const languages = Object.fromEntries(shopper.countries.filter((c) => c.enabled).map((c) => [`${c.language}-${c.country}`, `/shop/${handle}?country=${c.country}`]));
  const photo = product.photos[0];
  return {
    metadataBase: new URL(shopper.baseUrl),
    // The shop's own title (at most 60 characters), not the dashboard's title template
    title: { absolute: product.seo.metaTitle },
    description: product.seo.metaDescription,
    alternates: {
      canonical: shopper.countryParam ? `/shop/${handle}?country=${shopper.countryParam}` : `/shop/${handle}`,
      languages: { ...languages, "x-default": `/shop/${handle}` },
    },
    openGraph: {
      title: product.seo.metaTitle,
      description: product.seo.metaDescription,
      locale: shopper.locale.replace("-", "_"),
      images: photo ? [{ url: `/api/photos/${photo.id}`, width: photo.width ?? undefined, height: photo.height ?? undefined }] : undefined,
    },
  };
}

export default async function ProductPage(props: PageProps<"/shop/[handle]">) {
  const { handle, shopper, product } = await load(props);
  // Only when the two cached reads in load disagree for a moment (the product just went on or off sale): the
  // not-found page still shows (and isn't indexed), but by now the response has started, so it stays a 200
  if (!product) notFound();
  const { text } = shopper;
  const price = (cents: number | null, currency: string | null) => (cents !== null && currency ? formatPrice(cents, currency, shopper.locale) : text.priceOnRequest);

  return (
    <div lang={shopper.language} className="flex flex-1 flex-col">
      <ShopHeader shopper={shopper} switchHref={(country) => `/shop/${handle}?country=${country}`} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-10">
        <nav aria-label="Breadcrumb" className="text-sm text-stone-500">
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <li>
              <Link href={shopHref("/shop", shopper)} className="hover:text-stone-900 hover:underline dark:hover:text-stone-100">
                {text.allProducts}
              </Link>
            </li>
            {product.categoryPath.map((part) => (
              <li key={part.value} className="flex items-center gap-2">
                <span aria-hidden>›</span>
                <Link href={shopHref("/shop", shopper, { category: part.value })} className="hover:text-stone-900 hover:underline dark:hover:text-stone-100">
                  {part.label}
                </Link>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-6 grid gap-8 md:grid-cols-2 lg:gap-12">
          <PhotoGallery photos={product.photos} title={product.title} noPhoto={text.noPhoto} photoLabels={product.photos.map((_, i) => text.photo(i + 1))} />

          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{product.title}</h1>
            <div className="mt-5">
              <VariantPicker
                options={product.options}
                variants={product.variants.map((v) => ({ sku: v.sku, options: v.options, price: price(v.priceCents, v.currency) }))}
                labels={{ sku: text.sku, notAvailable: text.notAvailable }}
              />
            </div>

            {product.descriptionHtml && (
              <section className="mt-8">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">{text.description}</h2>
                {/* Supplier and AI HTML is cleaned when it's saved (only p, ul, ol, li, strong, em, br; no attributes) */}
                <div
                  className="mt-3 space-y-3 leading-relaxed text-stone-700 dark:text-stone-300 [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc"
                  dangerouslySetInnerHTML={{ __html: product.descriptionHtml }}
                />
              </section>
            )}

            {product.attributes.length > 0 && (
              <section className="mt-8">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">{text.details}</h2>
                <dl className="mt-3 divide-y divide-stone-200 border-y border-stone-200 text-sm dark:divide-stone-800 dark:border-stone-800">
                  {product.attributes.map((a) => (
                    <div key={a.key} className="grid grid-cols-3 gap-4 py-2.5">
                      <dt className="text-stone-500">{a.label}</dt>
                      <dd className="col-span-2">{a.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </div>
        </div>
      </main>
      <RememberCountry country={shopper.countryParam} />
    </div>
  );
}
