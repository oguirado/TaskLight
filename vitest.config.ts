import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "jsdom" } },
      { extends: true, test: { name: "rules", include: ["tests/rules/**/*.test.ts"], environment: "node", testTimeout: 20000 } }
    ]
  }
});
