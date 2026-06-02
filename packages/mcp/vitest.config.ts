import { defineConfig } from 'vitest/config';

// Package-local Vitest config. `pnpm -r test` runs `vitest run` from THIS
// package's cwd, so the include glob is resolved relative to packages/mcp.
// The contract tests live under src/**/__tests__/*.test.ts; this glob finds
// them. Tests never need a running Ableton Live: they run against the
// in-memory FakeLiveBridge.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**'],
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
