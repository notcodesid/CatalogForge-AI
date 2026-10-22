import type { Metadata } from "next";
import { LanguagesSettings } from "@/app/_components/dashboard/languages/languages-settings";

export const metadata: Metadata = { title: "Languages" };

// The Languages tab: which language each country's shoppers see, and how much of the catalog is translated
export default function LanguagesPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Languages</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Switch a country on to show it its language. Products are translated ahead of time, in the background, so
          shoppers never wait.
        </p>
      </div>
      <LanguagesSettings />
    </div>
  );
}
