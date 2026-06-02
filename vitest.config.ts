import { defineConfig } from 'vitest/config';

// Workspace-aware root config. Each package runs `vitest run` from its own
// directory and inherits these settings; the root `pnpm -r test` fans out per
// package. Tests never need a running Ableton Live: rings 1 and 2 run against
// the FakeLiveBridge in-memory model (see research/03).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/src/**/*.{test,spec}.ts', 'packages/**/tests/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/**/src/**'],
      exclude: [
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/dist/**',
        // The real Ableton SDK adapter cannot run in CI (no Live); smoke-tested
        // manually. Keep it thin and exclude it from coverage honestly.
        '**/live-bridge.ableton.ts',
      ],
    },
  },
});
