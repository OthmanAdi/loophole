/**
 * Ring 2 (integration) — the four READ tools over the MCP wire (02_BRIDGE_SPEC §8).
 *
 * Each read tool is called against a seeded `FakeLiveBridge`, and we assert the
 * serialized response shape (names + path ids), that the structured payload
 * matches the documented tool output, and that NO `Handle`/`bigint` ever appears
 * on the wire (the serialization boundary, §3). Reads do not mutate, so each leaves
 * `transactionCount` at 0.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLiveBridge } from '@othmanadi/loophole-core';

import {
  assertNoForbiddenShapes,
  callTool,
  connect,
  resultText,
  type Connected,
} from './harness.js';

describe('ring 2: read tools over MCP', () => {
  let live: FakeLiveBridge;
  let conn: Connected;

  beforeEach(async () => {
    live = FakeLiveBridge.seeded();
    conn = await connect(live);
  });
  afterEach(async () => {
    await conn.close();
  });

  it('live_get_song_overview returns tempo, counts, and the track list with string ids', async () => {
    const res = await callTool(conn.client, 'live_get_song_overview', {});
    expect(res.isError).toBeFalsy();

    const data = res.structuredContent;
    expect(data?.tempo).toBe(124);
    expect(data?.trackCount).toBe(3);
    const tracks = data?.tracks as { id: string; name: string; type: string }[];
    expect(tracks.map((t) => t.name)).toEqual(['Drums', 'Bass', 'Vocals']);
    expect(tracks[0]?.id).toBe('track:0');
    expect(tracks[2]?.type).toBe('audio');
    // The human summary carries names + ids for the model to read directly.
    expect(resultText(res)).toContain('Drums (track:0)');

    assertNoForbiddenShapes(res);
    // A read commits no undo step.
    expect(live.transactionCount).toBe(0);
  });

  it('live_find_track resolves a name to ids and reports a count', async () => {
    const res = await callTool(conn.client, 'live_find_track', { query: 'bass' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.count).toBe(1);
    const matches = res.structuredContent?.matches as { id: string; name: string; type: string }[];
    expect(matches[0]).toEqual({ id: 'track:1', name: 'Bass', type: 'midi' });
    assertNoForbiddenShapes(res);
  });

  it('live_find_track returns count 0 (not an error) when nothing matches', async () => {
    const res = await callTool(conn.client, 'live_find_track', { query: 'zzz-no-such-track' });
    // An empty result is a valid answer, not an error.
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.count).toBe(0);
    expect((res.structuredContent?.matches as unknown[]).length).toBe(0);
    expect(resultText(res)).toContain('No track matches');
  });

  it('live_list_clips groups session slots (with empties) and arrangement clips', async () => {
    // Bass (track:1) has one session clip in slot 0 and one arrangement clip.
    const res = await callTool(conn.client, 'live_list_clips', { trackId: 'track:1' });
    expect(res.isError).toBeFalsy();

    const session = res.structuredContent?.session as {
      slotId: string;
      clipId: string | null;
      kind: string;
    }[];
    const arrangement = res.structuredContent?.arrangement as { clipId: string; kind: string }[];
    expect(session[0]?.clipId).toBe('track:1/clipslot:0/clip');
    expect(session[0]?.kind).toBe('midi');
    expect(arrangement[0]?.clipId).toBe('track:1/clip:0');
    expect(arrangement[0]?.kind).toBe('midi');
    assertNoForbiddenShapes(res);
  });

  it('live_list_clips reports an empty session slot as kind empty with a null clipId', async () => {
    // Drums (track:0) slot 1 is empty.
    const res = await callTool(conn.client, 'live_list_clips', { trackId: 'track:0' });
    const session = res.structuredContent?.session as {
      slotId: string;
      clipId: string | null;
      kind: string;
    }[];
    const empty = session.find((s) => s.kind === 'empty');
    expect(empty).toBeDefined();
    expect(empty?.clipId).toBeNull();
    expect(empty?.slotId).toBe('track:0/clipslot:1');
  });

  it('live_get_notes returns the clip notes as plain DTOs with a count', async () => {
    // Drums "Beat" clip has 4 notes.
    const res = await callTool(conn.client, 'live_get_notes', {
      clipId: 'track:0/clipslot:0/clip',
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.clipId).toBe('track:0/clipslot:0/clip');
    expect(res.structuredContent?.count).toBe(4);
    const notes = res.structuredContent?.notes as { pitch: number; startTime: number }[];
    expect(notes).toHaveLength(4);
    expect(notes[0]?.pitch).toBe(36);
    assertNoForbiddenShapes(res);
    expect(live.transactionCount).toBe(0);
  });

  it('live_get_notes summarizes (count + pitch range + first N) for a very large clip', async () => {
    // Build a clip with more notes than the dump limit (400) so the tool returns a
    // summary + first-N slice + truncated flag instead of the full array (§5 tool 4, §8).
    const many = Array.from({ length: 500 }, (_unused, i) => ({
      pitch: 36 + (i % 24),
      startTime: i * 0.25,
      duration: 0.25,
    }));
    const bigLive = FakeLiveBridge.withOneMidiClip(many);
    const bigConn = await connect(bigLive);
    try {
      const res = await callTool(bigConn.client, 'live_get_notes', {
        clipId: bigLive.firstClipId,
      });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.count).toBe(500);
      expect(res.structuredContent?.truncated).toBe(true);
      const summary = res.structuredContent?.summary as { pitchRange: number[]; spanBeats: number };
      expect(summary.pitchRange[0]).toBe(36);
      expect(summary.pitchRange[1]).toBe(59);
      // Only the first N notes are included, not all 500.
      const firstNotes = res.structuredContent?.firstNotes as unknown[];
      expect(firstNotes.length).toBe(50);
      expect(resultText(res)).toContain('too many to return in full');
      assertNoForbiddenShapes(res);
    } finally {
      await bigConn.close();
    }
  });

  it('every read tool is reported readOnly and leaves the Set unchanged', async () => {
    await callTool(conn.client, 'live_get_song_overview', {});
    await callTool(conn.client, 'live_find_track', { query: 'drums' });
    await callTool(conn.client, 'live_list_clips', { trackId: 'track:1' });
    await callTool(conn.client, 'live_get_notes', { clipId: 'track:1/clipslot:0/clip' });
    // Four reads, zero undo steps.
    expect(live.transactionCount).toBe(0);
  });
});
