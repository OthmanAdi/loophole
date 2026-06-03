/**
 * Ring 2 (integration) — read-only Resources and recipe Prompts over the MCP wire
 * (02_BRIDGE_SPEC §6).
 *
 * Resources mirror the read tools and return JSON (names + path ids, never a
 * handle), capped at the character limit. `ableton://song` is a fixed resource;
 * `ableton://track/{i}` and `ableton://clip/{path}/notes` are templates reached via
 * `readResource` (only the fixed resource appears in `listResources`). The clip
 * template carries a percent-encoded clip id in its single `{path}` segment, which
 * the handler decodes. Prompts are templates that compose the 12 tools, with NO
 * Sampling. The forbidden-shape scan runs on resource text too, not just tool
 * results.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLiveBridge } from '@othmanadi/loophole-core';

import { assertNoForbiddenShapes, connect, type Connected } from './harness.js';

/** Parse the JSON text body of the first content block of a resource read. */
function resourceJson(result: { contents: readonly { text?: string }[] }): unknown {
  const text = result.contents[0]?.text ?? '';
  return JSON.parse(text);
}

describe('ring 2: resources over MCP', () => {
  let conn: Connected;

  beforeEach(async () => {
    conn = await connect(FakeLiveBridge.seeded());
  });
  afterEach(async () => {
    await conn.close();
  });

  it('lists the fixed song resource (templates are not enumerated)', async () => {
    const { resources } = await conn.client.listResources();
    expect(resources.map((r) => r.uri)).toContain('ableton://song');
  });

  it('exposes the two resource templates with their URI templates', async () => {
    const { resourceTemplates } = await conn.client.listResourceTemplates();
    const templates = resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain('ableton://track/{i}');
    expect(templates).toContain('ableton://clip/{path}/notes');
  });

  it('reads ableton://song as the overview JSON with string track ids', async () => {
    const res = await conn.client.readResource({ uri: 'ableton://song' });
    expect(res.contents[0]?.mimeType).toBe('application/json');
    const data = resourceJson(res) as {
      tempo: number;
      tracks: { id: string; name: string }[];
    };
    expect(data.tempo).toBe(124);
    expect(data.tracks[0]?.id).toBe('track:0');
    assertNoForbiddenShapes(data);
  });

  it('reads ableton://track/{i} as that track clips + device params', async () => {
    // Vocals (track 2) has clips and EQ Eight + Compressor params.
    const res = await conn.client.readResource({ uri: 'ableton://track/2' });
    const data = resourceJson(res) as {
      trackId: string;
      clips: unknown[];
      params: { id: string; name: string }[];
    };
    expect(data.trackId).toBe('track:2');
    expect(data.params.length).toBe(2);
    expect(data.params[0]?.id).toBe('track:2/device:0/param:0');
    assertNoForbiddenShapes(data);
  });

  it('reads ableton://clip/{path}/notes with a percent-encoded clip id', async () => {
    const clipId = 'track:0/clipslot:0/clip';
    const uri = `ableton://clip/${encodeURIComponent(clipId)}/notes`;
    const res = await conn.client.readResource({ uri });
    const data = resourceJson(res) as {
      clipId: string;
      count: number;
      notes: { pitch: number }[];
    };
    // The handler decoded the path back to the real clip id.
    expect(data.clipId).toBe(clipId);
    expect(data.count).toBe(4);
    expect(data.notes[0]?.pitch).toBe(36);
    assertNoForbiddenShapes(data);
  });
});

describe('ring 2: prompts over MCP', () => {
  let conn: Connected;

  beforeEach(async () => {
    conn = await connect(FakeLiveBridge.seeded());
  });
  afterEach(async () => {
    await conn.close();
  });

  it('lists the three recipe prompts', async () => {
    const { prompts } = await conn.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      'batch_rename',
      'build_arrangement',
      'humanize_clip',
    ]);
  });

  it('fills humanize_clip into a single user message referencing the tools', async () => {
    const res = await conn.client.getPrompt({
      name: 'humanize_clip',
      arguments: { clipId: 'track:0/clipslot:0/clip', amount: '0.1' },
    });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]?.role).toBe('user');
    const content = res.messages[0]?.content;
    const text = content?.type === 'text' ? content.text : '';
    // The scaffold composes the read + write tools and threads the args in.
    expect(text).toContain('track:0/clipslot:0/clip');
    expect(text).toContain('0.1');
    expect(text).toContain('live_get_notes');
    expect(text).toContain('live_set_notes');
  });

  it('fills batch_rename with its pattern argument', async () => {
    const res = await conn.client.getPrompt({
      name: 'batch_rename',
      arguments: { pattern: 'prefix drum tracks with DRUM_' },
    });
    const content = res.messages[0]?.content;
    const text = content?.type === 'text' ? content.text : '';
    expect(text).toContain('prefix drum tracks with DRUM_');
    expect(text).toContain('live_set_track_props');
  });

  it('fills build_arrangement, with the optional style argument omitted', async () => {
    const res = await conn.client.getPrompt({ name: 'build_arrangement', arguments: {} });
    const content = res.messages[0]?.content;
    const text = content?.type === 'text' ? content.text : '';
    expect(text).toContain('live_get_song_overview');
  });
});
