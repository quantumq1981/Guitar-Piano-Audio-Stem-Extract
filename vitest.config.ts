import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'scripts/ci/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
