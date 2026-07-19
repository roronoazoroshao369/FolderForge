import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
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
