import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclusions: files that require live infra to exercise.
      //   - cli/start.ts: HTTP boundary, exercised by ./demo.bash integration.
      //     Replaced by Fastify routes with real unit tests in Phase 5.
      //   - valkey-pg.ts / migrate.ts: require live PG + Valkey.
      //     Exercised by the conformance suite in CI's storage job.
      exclude: [
        'src/scratch.ts',
        'src/main.ts',
        'src/cli/start.ts',
        'src/storage/valkey-pg.ts',
        'src/storage/migrate.ts',
        '**/*.test.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
