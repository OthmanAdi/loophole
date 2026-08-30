/**
 * Integration coverage for the eight WRITE tools over the MCP wire. For each
 * write tool, three claims:
 *  1. the MCP response is a clean success with the documented structured payload;
 *  2. the resulting `FakeLiveBridge` STATE changed as expected (real state, not
 *     just the echoed response);
 *  3. the FIRST-CLASS assertion: the fake recorded EXACTLY ONE transaction / one
 *     undo step for that one tool call (`transactionCount` grows by exactly one).
 *     This proves "one tool call = one withinTransaction = one undo" with no Live.
 *
 * `live_render_track` is the deliberate exception: it produces a file and does not
 * change the Set, so it commits ZERO undo steps (asserted as such). Every response
 * is scanned for forbidden `Handle`/`bigint` shapes.
 *
 * A fresh seeded fake + fresh client per test (beforeEach) so `transactionCount`
 * starts at 0 and state is isolated.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ClipReference,
  ClipSlotReference,
  ParameterReference,
  TrackReference,
} from '@othmanadi/loophole-core';
import { FakeLiveBridge } from '@othmanadi/loophole-core';

import { assertNoForbiddenShapes, callTool, connect, type Connected } from './harness.js';

describe('write tools over MCP (response + state + one undo)', () => {
  let live: FakeLiveBridge;
  let conn: Connected;
  let drumsTrack: TrackReference;
  let bassTrack: TrackReference;
  let vocalsTrack: TrackReference;
  let drumClip: ClipReference;
  let emptyDrumSlot: ClipSlotReference;
  let drumParameter: ParameterReference;

  beforeEach(async () => {
    live = FakeLiveBridge.seeded();
    conn = await connect(live);
    const tracks = live.getSongOverview().tracks;
    drumsTrack = requiredReference(tracks.find((track) => track.name === 'Drums')?.id, 'Drums');
    bassTrack = requiredReference(tracks.find((track) => track.name === 'Bass')?.id, 'Bass');
    vocalsTrack = requiredReference(tracks.find((track) => track.name === 'Vocals')?.id, 'Vocals');
    const drumClips = live.listClips(drumsTrack);
    drumClip = requiredReference(
      drumClips.find((clip) => clip.location === 'session' && clip.kind === 'midi')?.id,
      'Drums MIDI clip',
    );
    emptyDrumSlot = requiredReference(
      drumClips.find((clip) => clip.location === 'session' && clip.kind === 'empty')?.slotId,
      'Drums empty slot',
    );
    drumParameter = requiredReference(
      (await live.listDeviceParams(drumsTrack))[0]?.id,
      'Drums parameter',
    );
    expect(live.transactionCount).toBe(0);
  });
  afterEach(async () => {
    await conn.close();
  });

  it('live_set_tempo sets the tempo and commits exactly one undo step', async () => {
    const res = await callTool(conn.client, 'live_set_tempo', { bpm: 142 });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.tempo).toBe(142);
    // Real state changed.
    expect(live.getSongOverview().tempo).toBe(142);
    // One tool call = one undo step.
    expect(live.transactionCount).toBe(1);
    assertNoForbiddenShapes(res);
  });

  it('live_set_track_props sets name + mute in ONE undo step', async () => {
    const res = await callTool(conn.client, 'live_set_track_props', {
      trackId: drumsTrack,
      props: { name: 'Kit', mute: true },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.name).toBe('Kit');
    expect(res.structuredContent?.mute).toBe(true);
    // Real state: both properties applied.
    const track = live.listTracks()[0];
    expect(track?.name).toBe('Kit');
    expect(track?.mute).toBe(true);
    // Two property writes batched into ONE undo step (the headline claim).
    expect(live.transactionCount).toBe(1);
    assertNoForbiddenShapes(res);
  });

  it('live_set_notes replaces the clip notes and commits one undo step', async () => {
    const res = await callTool(conn.client, 'live_set_notes', {
      clipId: drumClip,
      notes: [
        { pitch: 60, startTime: 0, duration: 1 },
        { pitch: 64, startTime: 1, duration: 1 },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.count).toBe(2);
    // Real state: the clip now holds the new notes.
    const notes = live.getNotes(drumClip);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.pitch).toBe(60);
    expect(live.transactionCount).toBe(1);
    assertNoForbiddenShapes(res);
  });

  it('live_create_track appends a track and commits one undo step', async () => {
    const before = live.listTracks().length;
    const res = await callTool(conn.client, 'live_create_track', { kind: 'midi' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.id).toMatch(/^lhref_trk_/);
    expect(res.structuredContent?.kind).toBe('midi');
    // Real state: one more track.
    expect(live.listTracks().length).toBe(before + 1);
    expect(live.transactionCount).toBe(1);
    assertNoForbiddenShapes(res);
  });

  it('live_create_midi_clip fills an empty slot and commits one undo step', async () => {
    // A seeded Drums session slot is empty.
    const res = await callTool(conn.client, 'live_create_midi_clip', {
      slotId: emptyDrumSlot,
      lengthBeats: 4,
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.clipId).toMatch(/^lhref_clip_/);
    // Real state: the new clip resolves and is empty.
    expect(live.getNotes(res.structuredContent?.clipId as ClipReference)).toEqual([]);
    expect(live.transactionCount).toBe(1);
    assertNoForbiddenShapes(res);
  });

  it('live_set_param writes a value in range and commits one undo step', async () => {
    // A seeded Drums device parameter has range 0..127.
    const res = await callTool(conn.client, 'live_set_param', {
      paramId: drumParameter,
      value: 64,
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.value).toBe(64);
    // Real state: the param reads back the written value (listDeviceParams is async).
    const params = await live.listDeviceParams(drumsTrack);
    expect(params[0]?.value).toBe(64);
    expect(live.transactionCount).toBe(1);
    assertNoForbiddenShapes(res);
  });

  it('live_insert_device adds a built-in device and commits one undo step', async () => {
    // Bass has no devices initially.
    const res = await callTool(conn.client, 'live_insert_device', {
      trackId: bassTrack,
      deviceName: 'Reverb',
      index: 0,
    });
    expect(res.isError).toBeFalsy();
    const device = res.structuredContent?.device as { id: string; name: string };
    expect(device.name).toBe('Reverb');
    expect(device.id).toMatch(/^lhref_dev_/);
    // The returned param ids are addressable for a follow-up live_set_param.
    const params = res.structuredContent?.params as { id: string; name: string }[];
    expect(params[0]?.id).toMatch(/^lhref_param_/);
    // Real state: the device is on the track (listDeviceParams is async).
    expect((await live.listDeviceParams(bassTrack)).length).toBeGreaterThan(0);
    expect(live.transactionCount).toBe(1);
    assertNoForbiddenShapes(res);
  });

  it('live_render_track returns a WAV path and commits ZERO undo steps (the exception)', async () => {
    // Vocals is the audio track the seeded render accepts.
    const res = await callTool(conn.client, 'live_render_track', {
      trackId: vocalsTrack,
      startBeat: 0,
      endBeat: 8,
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.track).toBe('Vocals');
    expect(res.structuredContent?.path).toBe('/tmp/loophole/render/Vocals_0-8.wav');
    // A render produces a file, not a Set change: NO undo step. This is the one
    // write-annotated tool that does not increment the transaction count.
    expect(live.transactionCount).toBe(0);
    assertNoForbiddenShapes(res);
  });

  it('a sequence of mutating calls accrues exactly one undo step each', async () => {
    // Seven mutations (render excluded): each call = exactly one undo step.
    await callTool(conn.client, 'live_set_tempo', { bpm: 100 });
    expect(live.transactionCount).toBe(1);
    await callTool(conn.client, 'live_set_track_props', {
      trackId: drumsTrack,
      props: { name: 'A' },
    });
    expect(live.transactionCount).toBe(2);
    await callTool(conn.client, 'live_set_notes', {
      clipId: drumClip,
      notes: [],
    });
    expect(live.transactionCount).toBe(3);
    await callTool(conn.client, 'live_create_track', { kind: 'audio' });
    expect(live.transactionCount).toBe(4);
    await callTool(conn.client, 'live_create_midi_clip', {
      slotId: emptyDrumSlot,
      lengthBeats: 2,
    });
    expect(live.transactionCount).toBe(5);
    await callTool(conn.client, 'live_set_param', {
      paramId: drumParameter,
      value: 10,
    });
    expect(live.transactionCount).toBe(6);
    await callTool(conn.client, 'live_insert_device', {
      trackId: bassTrack,
      deviceName: 'Delay',
      index: 0,
    });
    expect(live.transactionCount).toBe(7);
    // The render adds no undo step.
    await callTool(conn.client, 'live_render_track', {
      trackId: vocalsTrack,
      startBeat: 0,
      endBeat: 4,
    });
    expect(live.transactionCount).toBe(7);
  });
});

function requiredReference<T extends string>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Seeded bridge did not expose ${label}`);
  }
  return value;
}
