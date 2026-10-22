import Link from "next/link";
import { Suspense } from "react";
import { DashboardNav, DashboardTabs } from "@/app/_components/dashboard/nav";
import { focusClasses } from "@/app/_components/dashboard/ui";

// The merchant's side: header with the tabs (Upload, Products, Metrics) and a way to the storefront
export default function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-6 px-4 md:px-6">
          <Link href="/" className={`py-3 text-base font-semibold tracking-tight ${focusClasses} rounded-sm`}>
            CatalogForge
          </Link>
          {/* Which tab is active comes from the address, which isn't known while an import's page is prerendered */}
          <Suspense fallback={<DashboardTabs path={null} />}>
            <DashboardNav />
          </Suspense>
          <Link
            href="/shop"
            className={`ml-auto inline-flex min-h-10 items-center rounded-md px-2 text-sm font-medium text-muted-foreground hover:text-foreground ${focusClasses}`}
          >
            Storefront <span aria-hidden className="ml-1">↗</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-6 md:py-8">{children}</main>
    </div>
  );
}
