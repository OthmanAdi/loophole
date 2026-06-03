/**
 * Ring 2 test harness: wire a real MCP `Client` to a real `buildServer(bridge)`
 * over `InMemoryTransport.createLinkedPair()` (02_BRIDGE_SPEC §8).
 *
 * No HTTP, no auth, no port, no Ableton: the exact same server code that runs in
 * `activate()` runs here against a `FakeLiveBridge`. The auth / `node:http` /
 * Origin layer is the extension's concern and is deliberately NOT in this path;
 * ring 2 tests protocol-to-tool-to-bridge behaviour.
 *
 * This module is a `.ts` helper (not a `*.test.ts`), so Vitest does not collect it
 * as a suite; the integration test files import `connect` and the scan helpers.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../server.js';
import type { LiveBridge } from '@othmanadi/loophole-core';

/** A connected client plus a `close` that tears both transports down. */
export interface Connected {
  readonly client: Client;
  close(): Promise<void>;
}

/**
 * Build a server for `bridge`, link an in-memory transport pair, and connect a
 * fresh client. Returns the client and a `close` for symmetric teardown.
 */
export async function connect(bridge: LiveBridge): Promise<Connected> {
  const server = buildServer(bridge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'loophole-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** A tool result narrowed to the fields the integration tests read. */
export interface ToolCallResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/** Call a tool and return the result narrowed to the readable shape. */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return result as ToolCallResult;
}

/** The concatenated text of a tool result's content blocks. */
export function resultText(result: ToolCallResult): string {
  return result.content.map((block) => block.text ?? '').join('');
}

/** The stable error `code` a result carries, if it is a bridge error. */
export function resultCode(result: ToolCallResult): unknown {
  return result.structuredContent?.code;
}

/**
 * Assert that a serialized value carries NO forbidden host shape: no `bigint`
 * anywhere, and no property named `handle` or `id` whose value looks like a raw
 * SDK handle (`{ id: <number|bigint> }`). The bridge's public address is a string
 * path id (e.g. `"track:2"`), never a `Handle` and never a `bigint`; this guards
 * the serialization boundary (02_BRIDGE_SPEC §3, §8).
 *
 * Throws with a descriptive message on the first violation; returns silently when
 * clean. Designed to walk an arbitrary JSON-able object graph.
 */
export function assertNoForbiddenShapes(value: unknown, path = '$'): void {
  const t = typeof value;
  if (t === 'bigint') {
    throw new Error(`Forbidden bigint on the wire at ${path}`);
  }
  if (t === 'function' || t === 'symbol') {
    throw new Error(`Forbidden ${t} on the wire at ${path}`);
  }
  if (value === null || t !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertNoForbiddenShapes(item, `${path}[${String(i)}]`);
    });
    return;
  }
  const record = value as Record<string, unknown>;
  // A property literally named `handle` is the SDK reference type and must never
  // be serialized; ids are carried as the string path-id, not a `handle`.
  if ('handle' in record) {
    throw new Error(`Forbidden "handle" property on the wire at ${path}.handle`);
  }
  // An `id` field must be a STRING path id, never a numeric/bigint host id.
  if ('id' in record) {
    const id = record['id'];
    if (typeof id === 'number' || typeof id === 'bigint') {
      throw new Error(`Forbidden numeric id on the wire at ${path}.id (= ${String(id)})`);
    }
  }
  for (const [key, child] of Object.entries(record)) {
    assertNoForbiddenShapes(child, `${path}.${key}`);
  }
}

/**
 * The canonical list of all 12 tool names, in registration order, for the
 * `listTools` count + name assertions.
 */
export const EXPECTED_TOOL_NAMES = [
  'live_get_song_overview',
  'live_find_track',
  'live_list_clips',
  'live_get_notes',
  'live_set_tempo',
  'live_set_track_props',
  'live_set_notes',
  'live_create_track',
  'live_create_midi_clip',
  'live_set_param',
  'live_insert_device',
  'live_render_track',
] as const;
