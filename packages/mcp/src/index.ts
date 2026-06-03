/**
 * Loophole Bridge: the public surface of `@othmanadi/ableton-mcp`.
 *
 * The package is the published, transport-agnostic, SDK-free MCP server built on
 * the `LiveBridge` seam from `@othmanadi/loophole-core`. Consumers (the extension
 * shell, tests, a future standalone host) import {@link buildServer}, pass a
 * `LiveBridge` implementation, and connect the returned server to a transport of
 * their choosing. The Ableton SDK and the `node:http` transport are a later wave
 * and deliberately not here.
 */

export { buildServer } from './server.js';
export { VERSION } from './version.js';

// Re-export the LiveBridge port so a consumer can type its implementation
// against `@othmanadi/ableton-mcp` without also depending on core directly.
export type { LiveBridge } from '@othmanadi/loophole-core';
