// Sends a ping job and waits for the worker to finish it. Run with: pnpm queue:ping
import { startBoss } from "@/server/queue/boss";
import { queues, type PingJob, type PingResult } from "@/server/queue/queues";

const TIMEOUT_MS = 15_000;

async function main() {
  const boss = await startBoss("api");
  const sentAt = new Date();
  const jobId = await boss.send(queues.ping.name, { sentAt: sentAt.toISOString() } satisfies PingJob);
  if (!jobId) throw new Error("Queue refused the job");
  console.log(`sent ping ${jobId}, waiting for the worker...`);

  while (Date.now() - sentAt.getTime() < TIMEOUT_MS) {
    const [job] = await boss.findJobs<PingJob>(queues.ping.name, { id: jobId });
    if (job?.state === "completed") {
      const result = job.output as PingResult;
      console.log(`done: worker picked it up after ${result.waitedMs} ms, round trip ${Date.now() - sentAt.getTime()} ms`);
      await boss.stop();
      return;
    }
    if (job?.state === "failed") throw new Error(`ping failed: ${JSON.stringify(job.output)}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  await boss.stop();
  throw new Error(`No answer after ${TIMEOUT_MS / 1000}s. Is the worker running? (pnpm worker)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
