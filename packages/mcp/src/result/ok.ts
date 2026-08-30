/**
 * The tool result shape and its two constructors, `ok` and `err`.
 *
 * Every one of the 12 tools returns a {@link ToolResult}. It is deliberately a
 * structural subset of the MCP SDK's `CallToolResult` (text content + optional
 * `structuredContent` + optional `isError`), so a handler can be typed purely in
 * terms of this local type and never imports the MCP SDK. `registry.ts` adapts
 * it to the SDK callback type in one place.
 *
 * Two halves of the result contract:
 *  - `ok(data, summary)` returns a human-readable `summary` as text AND the typed
 *    `data` as `structuredContent`, so a model reads prose while a programmatic
 *    client can consume JSON. The complete UTF-8 JSON envelope is size-capped.
 *  - `err(message, hint, code)` returns `isError: true` with the message plus a
 *    recovery hint, so a tool NEVER throws to the protocol; the model can
 *    self-correct in one turn.
 */

import { boundedError, boundedSuccess } from './bounded-result.js';

/** A single text content block, matching the MCP `TextContent` shape. */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

/**
 * The result every tool handler returns.
 *
 * `structuredContent` is a JSON object (`Record<string, unknown>`) to match the
 * MCP `CallToolResult` contract: the wire carries a named object, not a bare
 * array or scalar. {@link ok} wraps non-object payloads accordingly.
 */
export interface ToolResult {
  readonly content: readonly TextBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/**
 * A successful tool result.
 *
 * @param data    the typed payload; surfaced as `structuredContent`.
 * @param summary an optional human-readable one-liner; when omitted, the JSON of
 *                `data` is used as the text. The complete result, including
 *                `structuredContent`, is bounded at the wire limit.
 */
export function ok(data: unknown, summary?: string): ToolResult {
  return boundedSuccess(data, summary);
}

/**
 * A failed tool result. Never thrown: returned as a normal result with
 * `isError: true` so the protocol stays clean and the model sees an actionable
 * message.
 *
 * @param message what went wrong.
 * @param hint    an optional recovery hint, appended on its own line.
 * @param code    an optional stable error code (a {@link BridgeErrorCode}),
 *                surfaced in `structuredContent` so a client can branch on it.
 */
export function err(message: string, hint?: string, code?: string): ToolResult {
  return boundedError(message, hint, code);
}
