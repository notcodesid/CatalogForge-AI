// What a shopper sees depends on their country (switcher link, cookie, or the country their IP is in), and an
// unknown product must answer with a real 404, which only works before a page starts streaming. So shop pages
// read the request first and render in one go, without a prerendered shell. They stay fast because every
// database read is cached for a minute (src/server/storefront/cached.ts): a big import writing rows doesn't slow
// shoppers down, and the AI is never called
export const instant = false;

export default function ShopLayout({ children }: LayoutProps<"/shop">) {
  return <div className="flex min-h-full flex-1 flex-col bg-white text-stone-900 dark:bg-stone-950 dark:text-stone-100">{children}</div>;
}
