import { revalidateTag } from "next/cache";

// Every cached storefront read carries this tag (see cached.ts)
export const STOREFRONT_TAG = "storefront";

// Call after anything shoppers see changes (a product approved, edited or deleted): the next storefront request
// reads fresh data instead of waiting out the cache's one-minute life. Only works inside a Next.js request
// (route handlers, server actions). Elsewhere (the worker, tests) there's nothing to clear, and the one-minute
// life catches up on its own, so it does nothing there instead of failing the caller
export function revalidateStorefront() {
  try {
    revalidateTag(STOREFRONT_TAG, { expire: 0 });
  } catch {
    // Not inside a Next.js request
  }
}
