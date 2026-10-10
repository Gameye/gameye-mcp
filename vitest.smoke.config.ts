import { defineConfig } from "vitest/config";

// The stdio smoke test drives a built server, so it is kept out of `npm test`
// and run after `npm run build` with `npm run test:smoke`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/smoke/**/*.smoke.test.ts"],
    testTimeout: 60_000,
  },
});
