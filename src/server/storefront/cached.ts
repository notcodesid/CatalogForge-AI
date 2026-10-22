import { cacheLife, cacheTag } from "next/cache";
import { getDb } from "@/server/db/client";
import type { Language } from "./country";
import { loadShopCategories, loadShopCountries, loadShopPage, loadShopProduct } from "./data";
import { STOREFRONT_TAG } from "./revalidate";

// The storefront's reads, cached per argument (language, category, page, handle). A big import writing thousands
// of rows doesn't slow shoppers down: they're served from this cache, which is read again in the background after
// a minute (stale-while-revalidate), so approvals and new translations show up within about a minute, or at once
// when revalidateStorefront() is called. Shoppers' cookies and headers are read outside and passed in as arguments

export async function shopCountries() {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag(STOREFRONT_TAG);
  return loadShopCountries(getDb());
}

export async function shopCategories(language: Language) {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag(STOREFRONT_TAG);
  return loadShopCategories(getDb(), language);
}

export async function shopPage(language: Language, category: string | null, page: number) {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag(STOREFRONT_TAG);
  return loadShopPage(getDb(), language, { category, page });
}

export async function shopProduct(handle: string, language: Language) {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag(STOREFRONT_TAG);
  return loadShopProduct(getDb(), handle, language);
}
