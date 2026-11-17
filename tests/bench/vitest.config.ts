import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: "tests/bench/.cache/vite",
  test: {
    name: "bench-infrastructure",
    include: ["tests/bench/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
