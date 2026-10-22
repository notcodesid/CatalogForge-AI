import type { Metadata } from "next";
import { Suspense } from "react";
import { MetricsDashboard, MetricsSkeleton } from "@/app/_components/dashboard/metrics/metrics-dashboard";

export const metadata: Metadata = { title: "Metrics" };

// The Metrics tab: products processed and how they ended, AI cost and speed, imports, the catalog and translation
// coverage. The period is read from the address at request time, so the dashboard sits inside Suspense and the
// rest of the page is prerendered
export default function MetricsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Metrics</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          How the imports went, what the AI cost and how fast it was, and how much of the catalog is translated.
        </p>
      </div>
      <Suspense fallback={<MetricsSkeleton />}>
        <MetricsDashboard />
      </Suspense>
    </div>
  );
}
