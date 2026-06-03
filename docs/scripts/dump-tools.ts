/**
 * dump-tools.ts: the single source of truth for the MCP tool reference.
 *
 * 04_LAUNCH_SPEC §1.5: the server is the source of truth, the docs are a
 * projection of it. This script boots the real Loophole Bridge server in-process
 * against `FakeLiveBridge` (no Ableton, no Live, no socket), wires an
 * `InMemoryTransport` MCP client to it, calls the standard `tools/list`
 * discovery endpoint, and writes the result to `src/data/tools.json`. The
 * `/mcp/tools/*` pages and the `llms.txt` tool block both render from that file,
 * so the docs can never drift from the running server.
 *
 * It runs in `predev` / `prebuild`, never by hand. A stale committed
 * `tools.json` is caught by `git diff --exit-code` in CI (the prebuild guard).
 *
 * Imports (why these resolve from a standalone, non-workspace project):
 *  - `buildServer` comes from the BUILT mcp bundle (`../../packages/mcp/dist`).
 *    tsup inlines `@othmanadi/loophole-core` (noExternal), so that bundle is
 *    self-contained and only needs `@modelcontextprotocol/sdk`, `zod`, `pino`
 *    (declared as docs devDependencies). The deploy workflow builds mcp before
 *    this script runs on a clean runner.
 *  - `FakeLiveBridge` comes from the core SOURCE (`../../packages/core/src`),
 *    run through tsx. Core has zero external runtime deps, so the source import
 *    pulls in nothing extra. During a `tools/list` dump no bridge method is ever
 *    called (handlers run on callTool, not listTools), so the instance is only
 *    captured in each handler's closure, never executed.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { FakeLiveBridge } from '../../packages/core/src/index.ts';

// `buildServer` comes from the BUILT mcp bundle, which does not exist on a fresh
// clone. Guard with a clear message before the dynamic import so a local run
// fails with "build the bridge first" instead of a cryptic module-not-found.
// (The deploy workflow builds the bridge before this step, so CI never hits it.)
const MCP_DIST_URL = new URL('../../packages/mcp/dist/index.js', import.meta.url);
if (!existsSync(fileURLToPath(MCP_DIST_URL))) {
  // eslint-disable-next-line no-console -- build script error channel
  console.error(
    'dump-tools: packages/mcp/dist not found. Build the bridge first:\n' +
      '  pnpm --filter @othmanadi/ableton-mcp build\n' +
      '(run from the monorepo root, then re-run the docs build).',
  );
  process.exit(1);
}
const mcp = (await import(MCP_DIST_URL.href)) as {
  buildServer: (bridge: unknown) => { connect(t: unknown): Promise<void>; close(): Promise<void> };
};
const { buildServer } = mcp;

/** Anchor the output to THIS file, not the process cwd. npm runs prebuild with
 * cwd = docs/, so a cwd-relative "src/data/tools.json" would land in the wrong
 * place; resolving against import.meta.url is stable wherever the script runs. */
const OUT_URL = new URL('../src/data/tools.json', import.meta.url);
const OUT_PATH = fileURLToPath(OUT_URL);

async function main(): Promise<void> {
  const bridge = FakeLiveBridge.seeded();
  const server = buildServer(bridge);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'loophole-docs-dump-tools', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();

  // Sort by name for a deterministic file (stable diffs, stable CI guard).
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));

  mkdirSync(fileURLToPath(new URL('../src/data/', import.meta.url)), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

  await client.close();
  await server.close();

  // eslint-disable-next-line no-console -- this is a build script, stdout is its log
  console.log(`dump-tools: wrote ${String(sorted.length)} tools to ${OUT_PATH}`);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- build script error channel
  console.error('dump-tools failed:', error);
  process.exit(1);
});
