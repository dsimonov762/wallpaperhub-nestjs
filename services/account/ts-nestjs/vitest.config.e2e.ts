import { defineConfig } from 'vitest/config';

// Integration tests: they need a real PostgreSQL (started with Testcontainers,
// or pointed to by TEST_DB_URL). Slower, so they run separately from unit tests.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
