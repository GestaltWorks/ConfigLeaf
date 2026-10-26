import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["vendor/**", "node_modules/**"],
    // The tests that spawn bash or git, and the sql.js passes over sample/bundle.json, take 1 to 4 s alone and ran past
    // vitest's 5 s default in the full parallel run once test/console.test.ts joined it (26 Oct 2026); none hangs.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
