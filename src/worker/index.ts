import { startBoss } from "@/server/queue/boss";
import { startWorker } from "./handlers";

async function main() {
  const boss = await startBoss("worker");
  const ai = await startWorker(boss);
  console.log(`[worker] started (AI: ${ai}), waiting for jobs`);

  let stopping = false;
  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal}: finishing current jobs, then stopping`);
    // Jobs still running after the timeout are picked up again on the next start
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[worker] failed to start", err);
  process.exit(1);
});
