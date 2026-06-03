import { defineConfig } from 'vitest/config';

// Package-local Vitest config. `pnpm -r test` runs `vitest run` from THIS
// package's cwd, so the include glob is resolved relative to packages/mcp.
// The ring-1 unit tests and ring-2 integration tests live under
// src/**/__tests__/*.test.ts; this glob finds them. Tests never need a running
// Ableton Live: they run against the in-memory FakeLiveBridge over an in-memory
// MCP transport (02_BRIDGE_SPEC §8).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      // `all: true` so every file under `include` is reported even if a test
      // never imports it; without it, an untested file would silently vanish
      // from the denominator and inflate the percentages.
      all: true,
      reporter: ['text', 'lcov'],
      include: ['src/**'],
      exclude: [
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/dist/**',
        // Test infrastructure (the ring-2 harness helper), not shipped code.
        '**/__tests__/harness.ts',
        // The real Ableton SDK adapter cannot run in CI (no Live); smoke-tested
        // manually. Keep it thin and exclude it from coverage honestly.
        '**/live-bridge.ableton.ts',
        // A runnable stdio entrypoint for the MCP Inspector CLI (02_BRIDGE_SPEC
        // §8): it calls process.exit and connects a real transport, so it is
        // contract-checked by the Inspector CLI, not by these in-process tests.
        '**/cifake.ts',
      ],
      // The CI thresholds from 02_BRIDGE_SPEC §8. Coverage below these FAILS the
      // test run, so the gate enforces them rather than merely reporting.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
