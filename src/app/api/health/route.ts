import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/server/db/client";
import { getApiBoss } from "@/server/queue/boss";

// GET /api/health: is the database up, is the queue installed, is a worker running?
export async function GET() {
  // Always run on request, never at build time
  await connection();

  const checks: Record<string, string> = {};

  try {
    await getDb().execute(sql`select 1`);
    checks.database = "ok";
  } catch (err) {
    checks.database = errorMessage(err);
  }

  let workersOnline = 0;
  try {
    const boss = await getApiBoss();
    const instances = await boss.getInstances();
    workersOnline = instances.filter((i) => i.name === "worker" && i.live).length;
    checks.queue = "ok";
  } catch (err) {
    checks.queue = errorMessage(err);
  }

  // A missing worker doesn't make the API unhealthy, it just means jobs wait
  const ok = checks.database === "ok" && checks.queue === "ok";
  return Response.json({ ok, checks, workersOnline }, { status: ok ? 200 : 503 });
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
