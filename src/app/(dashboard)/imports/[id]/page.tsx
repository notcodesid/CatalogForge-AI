import type { Metadata } from "next";
import { Suspense } from "react";
import { ImportCardSkeleton } from "@/app/_components/dashboard/import-card";
import { ImportDetail } from "@/app/_components/dashboard/import-detail";

export const metadata: Metadata = { title: "Import" };

// One import in detail: its rows, its photos and how the sheet was read. The id is only known at request time,
// so it's read inside Suspense (the rest of the page is prerendered)
export default function ImportPage({ params }: PageProps<"/imports/[id]">) {
  return (
    <Suspense fallback={<ImportCardSkeleton />}>
      <ImportFromParams params={params} />
    </Suspense>
  );
}

async function ImportFromParams({ params }: { params: PageProps<"/imports/[id]">["params"] }) {
  const { id } = await params;
  return <ImportDetail id={id} />;
}
