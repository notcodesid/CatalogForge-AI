import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/server/env";
import * as schema from "./schema";

// Limits every connection gets, so one stuck process can't hold up everyone else
export const DB_TIMEOUTS = {
  // A transaction left open (e.g. by a frozen worker) is cancelled after 60s, which releases its locks.
  // Without this, Postgres waits forever and every other worker touching the same rows waits with it
  idleInTransactionMs: 60_000,
  // Waiting more than 30s for another transaction's lock: give up with an error, the job retries later
  lockMs: 30_000,
  // No single query should ever take 2 minutes
  statementMs: 120_000,
};

export function createDb(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 10,
    // Fail fast instead of hanging when the database is unreachable
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: DB_TIMEOUTS.idleInTransactionMs,
    lock_timeout: DB_TIMEOUTS.lockMs,
    statement_timeout: DB_TIMEOUTS.statementMs,
    // Notice connections whose other end has silently gone away
    keepAlive: true,
  });

  // When Postgres restarts, or ends a transaction that sat open too long, the connection breaks and emits
  // an "error" event. An "error" event nobody listens to kills the whole Node process. So listen on every
  // connection: idle ones (pool "error") and ones in use (each client's own "error"). The query that was
  // using a broken connection still fails normally, and the job retries; the pool opens fresh connections
  pool.on("error", (err) => console.error("[db] lost an idle connection, will reconnect:", err.message));
  pool.on("connect", (client) => {
    client.on("error", (err) => console.error("[db] a connection in use was closed:", err.message));
  });

  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type Db = ReturnType<typeof createDb>;

// One pool per process. Next.js dev reloads modules on every change, so keep it on globalThis
const globalForDb = globalThis as unknown as { db?: Db };

export function getDb(): Db {
  globalForDb.db ??= createDb(env().DATABASE_URL);
  return globalForDb.db;
}
