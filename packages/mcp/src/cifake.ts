/**
 * CI / Inspector entry: a runnable stdio MCP server wired to a `FakeLiveBridge`.
 *
 * This wires `buildServer(FakeLiveBridge.seeded())` to a stdio transport so the
 * MCP Inspector CLI can run a language-agnostic, exit-code-gated protocol
 * contract check with NO Ableton present (02_BRIDGE_SPEC §8):
 *
 *   npx @modelcontextprotocol/inspector --cli node dist/cifake.js --method tools/list
 *
 * It complements (does not replace) the in-process ring-2 tests. Importing a
 * transport here is fine: this is an entrypoint, not a tool/resource/prompt, so
 * the import boundary (only `server.ts` imports the MCP SDK among the library
 * modules) is preserved.
 *
 * stdio discipline: on a stdio transport, stdout IS the JSON-RPC channel, so this
 * file must never write to stdout. All diagnostics go through the pino logger
 * (stderr); there is no `console.*` here.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FakeLiveBridge } from '@othmanadi/loophole-core';

import { buildServer } from './server.js';
import { log } from './logging/logger.js';

async function main(): Promise<void> {
  const bridge = FakeLiveBridge.seeded();
  const server = buildServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('loophole-bridge cifake server connected over stdio');
}

void main().catch((error: unknown) => {
  log.error({ err: error }, 'cifake server failed to start');
  process.exit(1);
});
