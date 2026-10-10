import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The stdio smoke test needs a build; it runs via `npm run test:smoke`.
    exclude: ["tests/smoke/**", "node_modules/**"],
  },
});
