/**
 * The bridge logger: a single `pino` instance writing to stderr (fd 2).
 *
 * stdout is reserved for the MCP JSON-RPC channel when the server runs over a
 * stdio transport (the cifake entry and any stdio host), so the bridge must
 * never write logs to stdout. Routing pino to fd 2 keeps diagnostics off the
 * wire; in Live, the Extension Host tees stderr into `ExtensionHost.txt`
 * (02_BRIDGE_SPEC §1.2). `no-console` is a lint warning for the same reason:
 * shipped code logs through this logger, never `console.*`.
 *
 * The level honours `LOOPHOLE_LOG_LEVEL` (falling back to `info`) so an operator
 * can raise verbosity without a code change.
 */

import pino, { type Logger } from 'pino';

/** The shared logger instance. Import this; do not construct your own pino. */
export const log: Logger = pino(
  {
    name: 'loophole-bridge',
    level: process.env['LOOPHOLE_LOG_LEVEL'] ?? 'info',
  },
  // fd 2 = stderr. Explicit so a future default-destination change in pino
  // cannot silently move logs onto stdout and corrupt the JSON-RPC stream.
  pino.destination(2),
);

/**
 * Serialize an unknown thrown value into a plain, log-safe object. `safeHandle`
 * (the one place tool failures are caught) uses this so a thrown `BridgeError`,
 * `Error`, or arbitrary value all log with a consistent, bounded shape.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const out: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack !== undefined) {
      out.stack = error.stack;
    }
    // Surface a BridgeError-style `code`/`hint` when present, without importing
    // the error type here (keeps this module dependency-light).
    const withCode = error as { code?: unknown; hint?: unknown };
    if (typeof withCode.code === 'string') {
      out.code = withCode.code;
    }
    if (typeof withCode.hint === 'string') {
      out.hint = withCode.hint;
    }
    return out;
  }
  return { value: String(error) };
}

/** Extract a human-readable message from an unknown thrown value. */
export function asMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
