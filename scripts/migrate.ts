// Applies the database migrations (drizzle/) with the app's own settings, so it also works where the database is
// only reachable from inside (AWS: run as a one-off ECS task). Locally `pnpm db:migrate` does the same with drizzle-kit
// Run with: pnpm db:deploy
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb } from "@/server/db/client";

async function main() {
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied");
  await db.$client.end();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
