/**
 * The tool registry: how a pure handler becomes a registered MCP tool.
 *
 * This is the one file in the tool layer that is allowed to know the MCP SDK
 * exists, and it touches only its TYPES (`McpServer`, `ToolCallback`,
 * `ToolAnnotations`). A tool file imports none of that: it calls {@link defineTool}
 * with a Zod input schema, a local {@link ToolAnnotationHints} object, and a pure
 * `handle(args, bridge)`. `defineTool` ties the handler's `args` type to the
 * schema via `z.infer`, then erases it into a {@link ToolModule} the collection
 * can hold heterogeneously.
 *
 * `registerTool` is where the wiring happens: it wraps the handler in
 * `safeHandle` (so it can never throw to the protocol, 02_BRIDGE_SPEC §7) and
 * hands the SDK the tool's Zod input schema plus its annotations. The
 * SDK-callback adaptation needs exactly one localized cast (`as ToolCallback`),
 * because the per-tool input generic cannot survive the erased array; the cast
 * is sound, since `safeHandle` validates nothing and the SDK parses `args`
 * against the same schema before calling us.
 */

import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { LiveBridge } from '@othmanadi/loophole-core';
import type { z } from 'zod';

import { safeHandle, type ToolHandler } from '../result/safe-handle.js';
import type { ToolResult } from '../result/ok.js';

/**
 * The MCP tool annotation hints the bridge sets, named locally so tool files do
 * not import the MCP SDK. Maps one-to-one onto the SDK's `ToolAnnotations`
 * (02_BRIDGE_SPEC §5):
 *  - `readOnlyHint`: true for the four reads, false for the eight writes.
 *  - `idempotentHint`: true for the setters (re-running with the same args lands
 *    the same state).
 *  - `destructiveHint`: false for all 12 (none deletes; overwrites are reversible
 *    by one undo).
 *  - `openWorldHint`: false for all 12 (a Live Set is a closed world).
 */
export interface ToolAnnotationHints {
  readonly readOnlyHint: boolean;
  readonly idempotentHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
}

/**
 * A fully-described, type-erased tool ready to register. `inputSchema` is a Zod
 * object schema (`.strict()`), and `handle` is the pure handler with its `args`
 * type already erased to `unknown` (it was checked against `inputSchema` at
 * {@link defineTool} time, and the SDK re-validates against the same schema at
 * call time).
 */
export interface ToolModule {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly annotations: ToolAnnotationHints;
  readonly handle: ToolHandler<unknown>;
}

/**
 * Define one tool. Generic over the input schema `S` so the `handle` callback's
 * `args` are typed as `z.infer<S>` at the definition site (full strict-TS
 * checking inside the handler), while the returned {@link ToolModule} erases that
 * generic so a heterogeneous array of tools can be collected.
 *
 * @param tool the tool definition: name, title, description, Zod input schema,
 *             annotation hints, and the pure handler.
 */
export function defineTool<S extends z.ZodType>(tool: {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly annotations: ToolAnnotationHints;
  readonly handle: (args: z.infer<S>, bridge: LiveBridge) => Promise<ToolResult>;
}): ToolModule {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    // Erase the input generic: the handler is checked against `inputSchema` here,
    // and the SDK parses incoming args against the same schema before calling it.
    handle: tool.handle as ToolHandler<unknown>,
  };
}

/**
 * Register one {@link ToolModule} on an {@link McpServer}: wrap its handler in
 * `safeHandle`, then hand the SDK the name, description, Zod input schema, and
 * annotations.
 *
 * The single cast (`as ToolCallback`) bridges the erased registry handler to the
 * SDK's per-schema callback type. It is localized here so no tool file, and no
 * other part of the server, needs it.
 *
 * @param tool   the tool to register.
 * @param server the MCP server to register it on.
 * @param bridge the `LiveBridge` the handler calls.
 */
export function registerTool(tool: ToolModule, server: McpServer, bridge: LiveBridge): void {
  const guarded = safeHandle(tool.name, tool.handle);
  // The SDK parses `args` against `inputSchema` before invoking this callback,
  // so the runtime value matches the handler's declared input. With an erased
  // `z.ZodType` schema the SDK types the callback as `ToolCallback<z.ZodType>`
  // (args: unknown, extra); we ignore `extra` and forward `args` to the guarded
  // handler. The single cast bridges the erased shape to the SDK's callback type.
  const callback = ((args: unknown): Promise<ToolResult> =>
    guarded(args, bridge)) as unknown as ToolCallback<z.ZodType>;
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations satisfies ToolAnnotations,
    },
    callback,
  );
}
