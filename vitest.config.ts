import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    // Integration-heavy suites perform real filesystem, Git, child-process, and
    // MCP transport work. Keep a bounded cross-platform budget instead of the
    // Vitest 5s default, which flakes on loaded 4-core CI/shared hosts.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
      thresholds: {
        statements: 72,
        branches: 60,
        functions: 79,
        lines: 75,
      },
    },
  },
});
