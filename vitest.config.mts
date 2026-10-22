import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Uploaded files written by tests go here and are deleted afterwards. TEST_STORAGE_DIR gives tests run side by
    // side (with their own TEST_DATABASE_URL) a folder of their own
    env: { STORAGE_DIR: process.env.TEST_STORAGE_DIR ?? ".storage-test" },
    // Rebuilds the test database from the migrations before every run
    globalSetup: ["./src/test/global-setup.ts"],
    // Test files share one database, so run them one at a time
    fileParallelism: false,
  },
});
