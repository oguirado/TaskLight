import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "semantic-history",
    include: ["tests/property/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180000,
  },
});
