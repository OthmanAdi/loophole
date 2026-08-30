/**
 * Loophole Bridge: the public surface of `@othmanadi/ableton-mcp`.
 *
 * The package is the published, transport-agnostic, SDK-free MCP server built on
 * the shared `LiveBridge` seam. Consumers (the extension shell, tests, a future
 * standalone host) import {@link buildServer}, pass a
 * `LiveBridge` implementation, and connect the returned server to a transport of
 * their choosing. The Ableton SDK and the `node:http` transport remain outside
 * this library by design.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServer as buildCoreServer } from './server.js';
import { toCoreLiveBridge, type LiveBridge } from './public-live-bridge.js';

export { VERSION } from './version.js';
export type { LiveBridge } from './public-live-bridge.js';

/** Build the registered MCP server from a structural, SDK-free bridge port. */
export function buildServer(bridge: LiveBridge): McpServer {
  return buildCoreServer(toCoreLiveBridge(bridge));
}
