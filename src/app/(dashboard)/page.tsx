import type { Metadata } from "next";
import { UploadTab } from "@/app/_components/dashboard/upload-tab";

export const metadata: Metadata = { title: "Upload" };

// The Upload tab: drop a supplier sheet and its photos, then follow every import live
export default function UploadPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Upload</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Drop a supplier sheet and its photos. The work runs in the background: rows are cleaned, written up by the AI, checked and translated, and you can
          follow each one here.
        </p>
      </div>
      <UploadTab />
    </div>
  );
}
