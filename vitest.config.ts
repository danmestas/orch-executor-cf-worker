import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration test spawns CLI child processes and a stub HTTP
    // server; widen the per-test budget so retries+backoff fit.
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
});
