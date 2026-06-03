/**
 * Ring 2 (integration) — the tool catalogue over the MCP wire (02_BRIDGE_SPEC §8).
 *
 * A real `Client` lists the tools of a real `buildServer(FakeLiveBridge)` over an
 * in-memory transport, and we assert the published catalogue: exactly 12 tools,
 * the right names, a valid JSON-Schema `inputSchema` per tool, and the annotation
 * hints (readOnly for the four reads, not for the eight writes; never destructive;
 * always closed-world). This catches tool-registration regressions and
 * input-schema drift, the failures a server that skips ring 2 ships silently.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLiveBridge } from '@othmanadi/loophole-core';

import { connect, EXPECTED_TOOL_NAMES, type Connected } from './harness.js';

const READ_TOOLS = new Set([
  'live_get_song_overview',
  'live_find_track',
  'live_list_clips',
  'live_get_notes',
]);

describe('ring 2: listTools over MCP', () => {
  let conn: Connected;

  beforeEach(async () => {
    conn = await connect(FakeLiveBridge.seeded());
  });
  afterEach(async () => {
    await conn.close();
  });

  it('returns exactly 12 tools with the right names in a stable order', async () => {
    const { tools } = await conn.client.listTools();
    expect(tools).toHaveLength(12);
    expect(tools.map((t) => t.name)).toEqual([...EXPECTED_TOOL_NAMES]);
  });

  it('gives every tool a non-empty description and a valid object input schema', async () => {
    const { tools } = await conn.client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      // The SDK publishes each Zod schema as JSON Schema; it must be an object
      // schema, and `.strict()` surfaces as additionalProperties: false.
      expect(tool.inputSchema.type, `${tool.name} schema type`).toBe('object');
      expect(tool.inputSchema, `${tool.name} is strict`).toMatchObject({
        additionalProperties: false,
      });
    }
  });

  it('publishes the documented required fields on representative tools', async () => {
    const { tools } = await conn.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    // live_get_song_overview takes no args: an object schema with no required.
    const overview = byName.get('live_get_song_overview');
    expect(overview?.inputSchema.required ?? []).toEqual([]);

    // live_set_tempo requires `bpm`, published with its numeric bounds.
    const tempo = byName.get('live_set_tempo');
    expect(tempo?.inputSchema.required).toEqual(['bpm']);
    const bpm = (tempo?.inputSchema.properties as Record<string, Record<string, unknown>>).bpm;
    expect(bpm.type).toBe('number');
    expect(bpm.minimum).toBe(20);
    expect(bpm.maximum).toBe(999);

    // live_set_notes requires clipId + notes.
    const setNotes = byName.get('live_set_notes');
    expect(new Set(setNotes?.inputSchema.required)).toEqual(new Set(['clipId', 'notes']));
  });

  it('sets readOnlyHint on the four reads and clears it on the eight writes', async () => {
    const { tools } = await conn.client.listTools();
    for (const tool of tools) {
      const expectedReadOnly = READ_TOOLS.has(tool.name);
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(expectedReadOnly);
    }
  });

  it('marks no tool destructive and every tool closed-world', async () => {
    const { tools } = await conn.client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(false);
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
    }
  });

  it('marks the setters idempotent and the create/insert tools non-idempotent', async () => {
    const { tools } = await conn.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    // Setters: re-running lands the same state.
    for (const name of [
      'live_set_tempo',
      'live_set_track_props',
      'live_set_notes',
      'live_set_param',
    ]) {
      expect(byName.get(name)?.annotations?.idempotentHint, `${name} idempotent`).toBe(true);
    }
    // Create/insert: each call adds another object.
    for (const name of ['live_create_track', 'live_create_midi_clip', 'live_insert_device']) {
      expect(byName.get(name)?.annotations?.idempotentHint, `${name} not idempotent`).toBe(false);
    }
  });
});
