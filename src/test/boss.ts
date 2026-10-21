import { startBoss } from "@/server/queue/boss";
import { testDatabaseUrl } from "./global-setup";

// pg-boss connected to the test database. Started as "api" so it doesn't run maintenance timers
export function startTestBoss() {
  return startBoss("api", { connectionString: testDatabaseUrl() });
}
