import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@/server/db/client";

export function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set. Copy .env.example to .env.local");
  return url;
}

// Wipes the test database (our tables and the queue's) and runs every migration from scratch,
// so tests also prove the migrations work
export default async function setup() {
  const db = createDb(testDatabaseUrl());
  try {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    // pg-boss rebuilds its tables the first time a test starts it
    await db.execute(sql`drop schema if exists pgboss cascade`);
    await db.execute(sql`create schema public`);
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await db.$client.end();
  }
}
