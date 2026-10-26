import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["vendor/**", "node_modules/**"],
    // Several setup hooks build git repositories and run bash (test/actions, explain, loop, parity and vault), and one
    // actions probe test waits on real child processes. Under load those took over vitest's 10 s hook and 5 s test
    // defaults on 26 Oct 2026 (and one actions test over 30 s), so a slow machine's npm test would fail on time alone.
    // 60 s each leaves them room; a test that names its own timeout keeps it. npm test (vitest run) and npx vitest run
    // both read this file, as vitest finds vitest.config.ts at the root.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
