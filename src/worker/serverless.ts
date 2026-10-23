import { startBoss } from "@/server/queue/boss";
import { startWorker } from "./handlers";
import { jobsLeft } from "./backlog";
import { wakeWorker } from "./wake";

// The worker on a host with no always-on machine (Vercel's free plan), switched on by WORKER_KEY. It runs in
// bursts inside a web function (/api/worker): a burst starts the normal worker, takes jobs for about 3 minutes, gives
// the running ones time to finish before the function's 300-second limit, and starts the next burst if work is left.
// Something that queues work (an upload, a retry, an edit to translate) starts a burst, and so does the dashboard
// when it sees work waiting with no worker online (wake.ts). A burst cut off mid-job is like a worker crash: the
// job's heartbeat stops and the next burst picks it up again

const TAKE_JOBS_MS = 190_000;
const FINISH_JOBS_MS = 80_000;

export async function runWorkerBurst(origin: string) {
  const started = Date.now();
  const boss = await startBoss("worker");
  await startWorker(boss);
  console.log("[worker] burst started");
  // Take jobs until the time is up, or until nothing has been left to do for 15 s
  let idle = 0;
  while (Date.now() - started < TAKE_JOBS_MS && idle < 3) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    idle = (await jobsLeft()) === 0 ? idle + 1 : 0;
  }
  // Jobs still running when this runs out are picked up again by the next burst
  await boss.stop({ graceful: true, timeout: FINISH_JOBS_MS });
  const left = await jobsLeft();
  console.log(`[worker] burst stopped after ${Math.round((Date.now() - started) / 1000)} s, ${left} jobs left`);
  if (left > 0) await wakeWorker(origin);
}
