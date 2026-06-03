/**
 * `buildServer(bridge)`: construct the Loophole Bridge MCP server, transport-agnostic.
 *
 * This is the ONLY module outside `tools` / `resources` / `prompts` that imports
 * the MCP SDK (02_BRIDGE_SPEC §9). It builds an `McpServer`, registers all 12
 * tools through the registry (which applies `safeHandle`), then the read-only
 * resources and the recipe prompts. It does NOT create a transport, open a
 * socket, or import `node:http`: the extension shell constructs the transport and
 * calls `server.connect(...)` in a later wave, and tests connect an
 * `InMemoryTransport` to the same server (02_BRIDGE_SPEC §1.3, §8).
 *
 * Because the server is built purely from the `LiveBridge` port, the exact same
 * server code runs against `FakeLiveBridge` in CI and against the real
 * `AbletonLiveBridge` in Live.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveBridge } from '@othmanadi/loophole-core';

import { collectTools, registerTool } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { VERSION } from './version.js';

/**
 * Build a fully-registered MCP server for the given {@link LiveBridge}.
 *
 * @param bridge the bridge the tools and resources read from / write to. In CI
 *               this is a `FakeLiveBridge`; in Live it is the `AbletonLiveBridge`
 *               adapter. The server never sees an SDK handle or type.
 * @returns an `McpServer` with all 12 tools, the read-only resources, and the
 *          recipe prompts registered. Connect it to a transport to serve.
 */
export function buildServer(bridge: LiveBridge): McpServer {
  const server = new McpServer({ name: 'loophole-bridge', version: VERSION });

  for (const tool of collectTools()) {
    registerTool(tool, server, bridge);
  }
  registerResources(server, bridge);
  registerPrompts(server);

  return server;
}
