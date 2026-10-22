import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { aiStatus } from "@/server/db/schema";
import { testDatabaseUrl } from "@/test/global-setup";
import { AiPausedError, pauseProvider, waitForTurn } from "./rate-limit";

const db = createDb(testDatabaseUrl());

async function pauseOf(provider: string) {
  const [row] = await db.select().from(aiStatus).where(eq(aiStatus.provider, provider));
  return row;
}

beforeEach(async () => {
  await db.execute(sql`truncate ai_status`);
});

afterAll(async () => {
  await db.$client.end();
});

describe("waitForTurn", () => {
  it("spaces calls out to stay under the requests-per-minute limit, across all callers", async () => {
    const started = Date.now();
    // 600 a minute = one every 100 ms. Five calls at once must take about 400 ms in total
    await Promise.all(Array.from({ length: 5 }, () => waitForTurn(db, "test", { requestsPerMinute: 600 })));
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
  });

  it("doesn't wait at all without a limit", async () => {
    const started = Date.now();
    await Promise.all(Array.from({ length: 5 }, () => waitForTurn(db, "test", {})));
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("waits out a short pause", async () => {
    await pauseProvider(db, "test", new Date(Date.now() + 300), "Too many requests");
    const started = Date.now();
    await waitForTurn(db, "test", {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("hands a long pause back to the caller instead of sitting in it", async () => {
    await pauseProvider(db, "test", new Date(Date.now() + 10 * 60_000), "Too many requests");
    const err = await waitForTurn(db, "test", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiPausedError);
    expect((err as AiPausedError).message).toBe("Too many requests");
    expect(await pauseOf("test")).toMatchObject({ reason: "Too many requests" });
  });

  it("never shortens a pause that's already longer", async () => {
    const long = new Date(Date.now() + 60_000);
    await pauseProvider(db, "test", long, "first");
    await pauseProvider(db, "test", new Date(Date.now() + 1000), "second");
    expect((await pauseOf("test")).pausedUntil!.getTime()).toBe(long.getTime());
  });
});
