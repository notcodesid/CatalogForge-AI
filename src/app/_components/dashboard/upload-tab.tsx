"use client";

import { useState } from "react";
import { ImportList } from "./import-list";
import { UploadPanel } from "./upload-panel";

// The Upload tab: a new upload refreshes the list right away instead of waiting for its next check
export function UploadTab() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="space-y-8">
      <UploadPanel onChanged={() => setRefreshKey((k) => k + 1)} />
      <section aria-labelledby="imports-heading" className="space-y-3">
        <h2 id="imports-heading" className="text-base font-semibold">
          Imports
        </h2>
        <ImportList refreshKey={refreshKey} />
      </section>
    </div>
  );
}
