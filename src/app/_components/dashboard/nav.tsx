"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { focusClasses } from "./ui";

// The dashboard's tabs. A new tab is one more entry here plus its page in app/(dashboard)
const DASHBOARD_TABS = [
  // Import details (/imports/...) belong to the Upload tab
  { href: "/", label: "Upload", isActive: (path: string) => path === "/" || path.startsWith("/imports") },
  { href: "/products", label: "Products", isActive: (path: string) => path.startsWith("/products") },
  { href: "/metrics", label: "Metrics", isActive: (path: string) => path.startsWith("/metrics") },
  { href: "/languages", label: "Languages", isActive: (path: string) => path.startsWith("/languages") },
];

export function DashboardNav() {
  return <DashboardTabs path={usePathname()} />;
}

// The tabs themselves. Without a path (while the page's address is still being resolved) none is highlighted
export function DashboardTabs({ path }: { path: string | null }) {
  return (
    <nav aria-label="Dashboard" className="-mb-px flex gap-1 overflow-x-auto">
      {DASHBOARD_TABS.map((tab) => {
        const active = path !== null && tab.isActive(path);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors ${focusClasses} ${
              active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
