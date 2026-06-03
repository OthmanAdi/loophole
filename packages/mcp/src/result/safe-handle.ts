/**
 * The single place a tool failure is caught and mapped, so a tool body NEVER
 * throws to the MCP protocol (02_BRIDGE_SPEC §7.2).
 *
 * Every SDK-shaped failure reaches the tool layer as a typed `BridgeError`
 * thrown by the bridge, carrying a stable {@link BridgeErrorCode} and a recovery
 * hint (the hint lives on the error itself; core populates a default per code).
 * `safeHandle` wraps a pure handler so that:
 *  - a thrown `BridgeError` becomes an `{ isError: true }` result with its
 *    `message` + `hint` + `code` (the model self-corrects in one turn);
 *  - any other throw becomes a generic `SDK_REJECTED`-coded error result;
 *  - the full error is logged to stderr (`ExtensionHost.txt` in Live) for the
 *    developer, while the model sees only the concise, actionable result.
 *
 * `registry.ts` applies this to every handler at registration time, so no tool
 * file needs to know it exists.
 */

import { isBridgeError, type LiveBridge } from '@othmanadi/loophole-core';

import { asMessage, log, serializeError } from '../logging/logger.js';
import { err, type ToolResult } from './ok.js';

/**
 * A pure tool handler: it receives the already-validated `args` and the
 * `LiveBridge`, calls one bridge method, and shapes the result with `ok`/`err`.
 * It may throw a `BridgeError`; it must not throw anything else by design.
 *
 * `Args` defaults to `unknown` so the registry can erase per-tool input types at
 * the heterogeneous collection boundary; each tool file types its own handler
 * with the precise `z.infer<...>` of its input schema.
 */
export type ToolHandler<Args = unknown> = (args: Args, bridge: LiveBridge) => Promise<ToolResult>;

/**
 * Wrap a tool handler so it can never throw to the protocol.
 *
 * @param name the tool name, for log correlation.
 * @param fn   the pure handler to guard.
 * @returns a handler with the same shape that always resolves to a
 *          {@link ToolResult}, returning an error result on any throw.
 */
export function safeHandle<Args>(name: string, fn: ToolHandler<Args>): ToolHandler<Args> {
  return async (args: Args, bridge: LiveBridge): Promise<ToolResult> => {
    try {
      return await fn(args, bridge);
    } catch (error) {
      log.error({ tool: name, err: serializeError(error) }, 'tool failed');
      if (isBridgeError(error)) {
        // The BridgeError already carries the mapped recovery hint per its code.
        return err(error.message, error.hint, error.code);
      }
      return err(
        `Unexpected failure in ${name}: ${asMessage(error)}`,
        'Retry once; if it persists, simplify the request.',
        'SDK_REJECTED',
      );
    }
  };
}
