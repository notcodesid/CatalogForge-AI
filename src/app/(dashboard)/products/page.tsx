import type { Metadata } from "next";
import { Suspense } from "react";
import { ProductsTab } from "@/app/_components/dashboard/products/products-tab";
import { Skeleton } from "@/app/_components/dashboard/ui";

export const metadata: Metadata = { title: "Products" };

// The Products tab. What's shown (filters, sort, page) comes from the address, which isn't known while the page is
// prerendered, so the tab is read inside Suspense and the rest of the page is ready at once
export default function ProductsPage() {
  return (
    <Suspense fallback={<ProductsSkeleton />}>
      <ProductsTab />
    </Suspense>
  );
}

function ProductsSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading products">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-10 max-w-xl" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
