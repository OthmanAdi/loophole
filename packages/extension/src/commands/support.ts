/**
 * Small shared helpers for the five context-menu command modules: parse the JSON
 * string a modal returns through `close_and_send`, and run a command's async body with
 * uniform error logging (the SDK's `registerCommand` callback is void-returning and
 * must never throw to the host, so each body is an async IIFE that we `.catch`).
 *
 * Imports no `@ableton-extensions/sdk` directly, but is used only by SDK-facing command
 * modules, so it shares their local-only typecheck lane. Pure TS + `console`.
 */

import { isBridgeError } from '@othmanadi/loophole-core';

/**
 * Parse the result string a modal posts via `close_and_send`. Returns the parsed object
 * on success, or `null` when the string is empty / not an object (e.g. the dialog was
 * dismissed without a structured result). Never throws: a malformed result is treated
 * as a cancel.
 */
export function parseModalResult<T>(result: string): T | null {
  if (result.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run a command's async body, logging any failure to stderr (which the host tees to
 * `ExtensionHost.txt`). A {@link BridgeError} is logged with its code + recovery hint;
 * any other error is logged generically. The returned Promise never rejects, so the
 * caller can pass it straight to the void-returning `registerCommand` callback.
 *
 * @param label the command label, for the log line.
 * @param body the async work (show modal, resolve handles, call the core handler).
 */
export async function runCommand(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (isBridgeError(error)) {
      console.error(
        `[loophole] ${label} failed: ${error.code} — ${error.message}` +
          (error.hint ? ` (${error.hint})` : ''),
      );
      return;
    }
    console.error(`[loophole] ${label} failed:`, error);
  }
}
