import { defineConfig } from 'tsup';

/**
 * Build config for `@othmanadi/ableton-mcp` (the published Loophole Bridge).
 *
 * Two entries:
 *  - `src/index.ts`  — the public library surface (`buildServer`, `LiveBridge`, `VERSION`).
 *  - `src/cifake.ts` — a runnable stdio entry that wires `buildServer(new FakeLiveBridge())`
 *    so the MCP Inspector CLI can run a protocol contract check with no Ableton present
 *    (02_BRIDGE_SPEC §8).
 *
 * `noExternal: ['@othmanadi/loophole-core']` forces the workspace `core` package to be
 * inlined into the published bundle (tsup externalizes workspace deps by default), so the
 * tarball is self-contained and never asks a consumer to resolve a private, source-only,
 * SDK-free workspace package. The `@modelcontextprotocol/sdk`, `zod`, and `pino` runtime
 * deps stay external (declared in package.json `dependencies`).
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/cifake.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  noExternal: ['@othmanadi/loophole-core'],
});
