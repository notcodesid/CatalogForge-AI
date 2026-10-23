// Deletes every import, product, translation, photo and AI call, and the uploaded files, so the app starts empty
// (before a demo or a deploy). Which countries get which language is kept: that's the shop's settings, not data.
// Run with: pnpm reset:data --yes
import { inArray, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { imports } from "@/server/db/schema";
import { deleteStoredFolder } from "@/server/storage";

async function main() {
  if (!process.argv.includes("--yes")) {
    console.log("This deletes every import, product, translation, photo and AI call, and the uploaded files.");
    console.log("Run it again with --yes to go ahead: pnpm reset:data --yes");
    return;
  }
  const db = getDb();
  // A running import would keep writing into the emptied tables
  const running = await db.select({ name: imports.sheetFileName }).from(imports).where(inArray(imports.status, ["queued", "running", "paused"]));
  if (running.length) throw new Error(`An import is still running (${running.map((r) => r.name).join(", ")}). Wait for it, or stop the worker first`);

  await db.execute(sql`truncate imports, import_rows, photos, products, variants, translations, translation_state, ai_calls, ai_cache, ai_status`);
  // Jobs left in the queue would point at imports that are gone. The queue's tables only exist once the worker ran
  await db.execute(sql`do $$ begin if to_regclass('pgboss.job') is not null then delete from pgboss.job; end if; end $$`);
  // The uploaded files, and the resized photos (stored by content, so no longer used by any product). In the
  // local folder or the bucket, wherever they are
  for (const folder of ["imports", "photos"]) await deleteStoredFolder(folder);
  console.log("Done: the app is empty. Language settings were kept.");
  await db.$client.end();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
