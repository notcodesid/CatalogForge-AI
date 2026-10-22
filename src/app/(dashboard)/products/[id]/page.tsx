import type { Metadata } from "next";
import { Suspense } from "react";
import { ProductReview, ReviewSkeleton } from "@/app/_components/dashboard/products/product-review";

export const metadata: Metadata = { title: "Review product" };

// One product's review screen. The id is only known at request time, so it's read inside Suspense (the rest of
// the page is prerendered)
export default function ProductPage({ params }: PageProps<"/products/[id]">) {
  return (
    <Suspense fallback={<ReviewSkeleton />}>
      <ProductFromParams params={params} />
    </Suspense>
  );
}

async function ProductFromParams({ params }: { params: PageProps<"/products/[id]">["params"] }) {
  const { id } = await params;
  return <ProductReview id={id} />;
}
