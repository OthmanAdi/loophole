/** Extended bridge contracts, resolving every opaque reference from live fixtures. */

import { describe, expect, it } from 'vitest';

import { isPlayableClip, type CreateAudioClipArgs } from '../dtos.js';
import { isBridgeErrorOfCode } from '../errors.js';
import { FakeLiveBridge } from '../fake-live-bridge.js';
import type { ClipId, ClipSlotId, TrackId } from '../ids.js';
import { makeSessionReference } from '../references.js';

const AUDIO_ARGS: CreateAudioClipArgs = { filePath: '/audio/loop.wav', startTime: 0, duration: 8 };

function trackAt(bridge: FakeLiveBridge, index: number): TrackId {
  return bridge.listTracks()[index]!.id;
}
function slotAt(bridge: FakeLiveBridge, track: number, index: number): ClipSlotId {
  const slot = bridge.listClips(trackAt(bridge, track))[index]!.slotId;
  if (slot === undefined) throw new Error('Expected a session slot');
  return slot;
}
function clipAt(bridge: FakeLiveBridge, track: number, index: number): ClipId {
  const clip = bridge.listClips(trackAt(bridge, track))[index]!;
  if (!isPlayableClip(clip)) throw new Error('Expected a clip');
  return clip.id;
}
function arrangementAt(bridge: FakeLiveBridge, track: number, index = 0): ClipId {
  const clip = bridge
    .listClips(trackAt(bridge, track))
    .filter(isPlayableClip)
    .filter((item) => item.location === 'arrangement')[index]!;
  return clip.id;
}
function unknownClip(): ClipId {
  return makeSessionReference('clip', 'unknownclipref00001');
}
function unknownTrack(): TrackId {
  return makeSessionReference('track', 'unknowntrackref0001');
}

describe('getTrackMixer: writable parameter references', () => {
  it('exposes volume min/max/default/current values', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const mixer = await bridge.getTrackMixer(trackAt(bridge, 0));
    expect(mixer.volume.id).toMatch(/^lhref_param_/);
    expect(mixer.volume).toMatchObject({ min: 0, max: 1, defaultValue: 0.85, value: 0.6 });
  });
  it('round-trips a reported volume reference', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const id = (await bridge.getTrackMixer(trackAt(bridge, 0))).volume.id;
    expect(await bridge.setParam(id, 0.5)).toMatchObject({ id, value: 0.5 });
    expect((await bridge.getTrackMixer(trackAt(bridge, 0))).volume.value).toBe(0.5);
  });
  it('commits one undo step and rejects out-of-range writes without mutation', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const id = (await bridge.getTrackMixer(trackAt(bridge, 0))).volume.id;
    await bridge.setParam(id, 0.7);
    expect(bridge.transactionCount).toBe(1);
    const fresh = FakeLiveBridge.seededAudioTrack();
    await expect(
      fresh.setParam((await fresh.getTrackMixer(trackAt(fresh, 0))).volume.id, 2),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    expect((await fresh.getTrackMixer(trackAt(fresh, 0))).volume.value).toBe(0.6);
    expect(fresh.transactionCount).toBe(0);
  });
  it('works for MIDI tracks and rejects unknown/wrong-kind refs', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect((await bridge.getTrackMixer(trackAt(bridge, 0))).volume.value).toBe(0.85);
    await expect(bridge.getTrackMixer(unknownTrack())).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
    );
    await expect(
      bridge.getTrackMixer(slotAt(bridge, 0, 0) as unknown as TrackId),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'));
  });
});

describe('listScenes: Session-to-Song fixture', () => {
  it('returns ordered names, opaque refs, and signatures', () => {
    const bridge = FakeLiveBridge.seededSession();
    const scenes = bridge.listScenes();
    expect(scenes).not.toBeInstanceOf(Promise);
    expect(scenes.map((scene) => scene.name)).toEqual(['Intro', 'Verse', 'Chorus']);
    expect(scenes.every((scene) => /^lhref_scn_/.test(scene.id))).toBe(true);
    expect(scenes[0]).toMatchObject({
      tempo: null,
      signatureNumerator: 4,
      signatureDenominator: 4,
    });
  });
  it('matches overview scene count', () => {
    const bridge = FakeLiveBridge.seededSession();
    expect(bridge.getSongOverview().sceneCount).toBe(bridge.listScenes().length);
  });
});

describe('setClipProps: session and arrangement writes', () => {
  it('sets session name/color and persists the fresh-list result', async () => {
    const bridge = FakeLiveBridge.seeded();
    const id = clipAt(bridge, 0, 0);
    expect(await bridge.setClipProps(id, { name: 'Kick Loop', color: 123 })).toMatchObject({
      id,
      name: 'Kick Loop',
      color: 123,
      location: 'session',
      slotId: slotAt(bridge, 0, 0),
    });
    expect(bridge.listClips(trackAt(bridge, 0))[0]).toMatchObject({
      name: 'Kick Loop',
      color: 123,
    });
  });
  it('preserves omitted fields and works for arrangement clips', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect((await bridge.setClipProps(clipAt(bridge, 1, 0), { name: 'Sub' })).color).toBe(255);
    const arrangement = await bridge.setClipProps(arrangementAt(bridge, 1), { color: 999 });
    expect(arrangement).toMatchObject({ location: 'arrangement', color: 999 });
    expect(arrangement.slotId).toBeUndefined();
  });
  it('uses one undo and rejects stale/wrong-kind refs', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.setClipProps(clipAt(bridge, 0, 0), { name: 'X' });
    expect(bridge.transactionCount).toBe(1);
    await expect(bridge.setClipProps(unknownClip(), { name: 'X' })).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
    );
    await expect(
      bridge.setClipProps(trackAt(bridge, 0) as unknown as ClipId, { name: 'X' }),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'));
  });
});

describe('deleteTrack and deleteClip', () => {
  it('deletes a track in one undo and makes its ref stale', async () => {
    const bridge = FakeLiveBridge.seeded();
    const bass = trackAt(bridge, 1);
    await bridge.deleteTrack(bass);
    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Drums', 'Vocals']);
    expect(bridge.transactionCount).toBe(1);
    await expect(bridge.deleteTrack(bass)).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
    );
    await expect(bridge.deleteTrack(slotAt(bridge, 0, 0) as unknown as TrackId)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'),
    );
  });
  it('empties a session slot but removes an arrangement item', async () => {
    const bridge = FakeLiveBridge.seeded();
    const session = clipAt(bridge, 0, 0);
    await bridge.deleteClip(session);
    expect(bridge.listClips(trackAt(bridge, 0))[0]).toMatchObject({
      kind: 'empty',
      slotId: slotAt(bridge, 0, 0),
    });
    await expect(bridge.deleteClip(session)).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
    );
    const arrangement = arrangementAt(bridge, 1);
    await bridge.deleteClip(arrangement);
    expect(
      bridge.listClips(trackAt(bridge, 1)).filter((clip) => clip.location === 'arrangement'),
    ).toEqual([]);
  });
  it('rejects unknown and wrong-kind clip refs without undo', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.deleteClip(unknownClip())).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
    );
    await expect(bridge.deleteClip(trackAt(bridge, 0) as unknown as ClipId)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'),
    );
    expect(bridge.transactionCount).toBe(0);
  });
});

describe('arrangement clip creation and clearing', () => {
  it('creates a fillable MIDI arrangement clip and commits once', async () => {
    const bridge = FakeLiveBridge.seeded();
    const clip = await bridge.createArrangementMidiClip(trackAt(bridge, 1), 16, 8);
    expect(clip).toMatchObject({
      kind: 'midi',
      location: 'arrangement',
      startTime: 16,
      duration: 8,
      endTime: 24,
    });
    const id = clip.id as ClipId;
    expect(bridge.getNotes(id)).toEqual([]);
    await bridge.setNotes(id, [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }]);
    expect(bridge.getNotes(id)).toHaveLength(1);
  });
  it('rejects non-MIDI tracks and invalid MIDI geometry', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.createArrangementMidiClip(trackAt(bridge, 2), 0, 4)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'),
    );
    await expect(bridge.createArrangementMidiClip(trackAt(bridge, 0), 0, 0)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
    await expect(bridge.createArrangementMidiClip(trackAt(bridge, 0), -1, 4)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
  });
  it('creates audio clips with their source file and validates args', async () => {
    const bridge = FakeLiveBridge.seeded();
    const clip = await bridge.createArrangementAudioClip(trackAt(bridge, 2), {
      filePath: '/audio/gtr.wav',
      startTime: 8,
      duration: 4,
    });
    expect(clip).toMatchObject({
      kind: 'audio',
      location: 'arrangement',
      filePath: '/audio/gtr.wav',
      startTime: 8,
      duration: 4,
    });
    expect(bridge.listClips(trackAt(bridge, 2)).find((item) => item.id === clip.id)?.filePath).toBe(
      '/audio/gtr.wav',
    );
    await expect(
      bridge.createArrangementAudioClip(trackAt(bridge, 0), AUDIO_ARGS),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'));
    await expect(
      bridge.createArrangementAudioClip(trackAt(bridge, 2), { ...AUDIO_ARGS, filePath: '' }),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    await expect(
      bridge.createArrangementAudioClip(trackAt(bridge, 2), { ...AUDIO_ARGS, duration: 0 }),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
  });
  it('clears inside clips, truncates overlaps, preserves outside clips, and validates ranges', async () => {
    const removed = FakeLiveBridge.seeded();
    await removed.clearClipsInRange(trackAt(removed, 1), 0, 8);
    expect(
      removed.listClips(trackAt(removed, 1)).filter((clip) => clip.location === 'arrangement'),
    ).toEqual([]);
    const truncated = FakeLiveBridge.seeded();
    await truncated.clearClipsInRange(trackAt(truncated, 1), 4, 8);
    expect(
      truncated
        .listClips(trackAt(truncated, 1))
        .filter((clip) => clip.location === 'arrangement')[0],
    ).toMatchObject({ startTime: 0, duration: 4, endTime: 4 });
    const untouched = FakeLiveBridge.seeded();
    await untouched.clearClipsInRange(trackAt(untouched, 1), 16, 24);
    expect(
      untouched
        .listClips(trackAt(untouched, 1))
        .filter((clip) => clip.location === 'arrangement')[0]?.duration,
    ).toBe(8);
    await expect(
      untouched.clearClipsInRange(slotAt(untouched, 0, 0) as unknown as TrackId, 0, 8),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'));
    await expect(untouched.clearClipsInRange(trackAt(untouched, 1), 8, 8)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
    await expect(untouched.clearClipsInRange(trackAt(untouched, 1), 8, 4)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
  });
});

describe('cue points, transactions, and fixtures', () => {
  it('creates ordered opaque cue refs and validates beats', async () => {
    const bridge = FakeLiveBridge.seeded();
    const first = await bridge.createCuePoint(16, 'Chorus');
    expect(first).toMatchObject({ time: 16, name: 'Chorus' });
    expect(first.id).toMatch(/^lhref_cue_/);
    await bridge.createCuePoint(32, 'Outro');
    const earlier = await bridge.createCuePoint(8, 'Intro');
    expect(earlier.id).toMatch(/^lhref_cue_/);
    expect(bridge.getSongOverview().cuePointCount).toBe(3);
    const invalid = FakeLiveBridge.seeded();
    await expect(invalid.createCuePoint(-1, 'A')).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
    await expect(invalid.createCuePoint(Number.NaN, 'A')).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
    expect(invalid.transactionCount).toBe(0);
  });
  it('batches Session-to-Song and Set-Janitor mutation groups, rolling failures back', async () => {
    const session = FakeLiveBridge.seededSession();
    await session.transaction(() =>
      Promise.all([
        session.clearClipsInRange(trackAt(session, 0), 0, 64),
        session.createArrangementMidiClip(trackAt(session, 0), 0, 16),
        session.createArrangementMidiClip(trackAt(session, 0), 16, 16),
        session.createCuePoint(0, 'Intro'),
        session.createCuePoint(16, 'Verse'),
      ]),
    );
    expect(session.transactionCount).toBe(1);
    expect(
      session.listClips(trackAt(session, 0)).filter((clip) => clip.location === 'arrangement'),
    ).toHaveLength(2);
    const messy = FakeLiveBridge.seededMessySet();
    const color = clipAt(messy, 0, 0);
    await messy.transaction(() =>
      Promise.all([
        messy.setClipProps(color, { color: 16711680 }),
        messy.setTrackProps(trackAt(messy, 1), { name: 'Keys' }),
        messy.deleteTrack(trackAt(messy, 2)),
      ]),
    );
    expect(messy.transactionCount).toBe(1);
    expect(messy.listTracks().map((track) => track.name)).toEqual(['Bass', 'Keys']);
    const rollback = FakeLiveBridge.seededMessySet();
    const before = rollback.listClips(trackAt(rollback, 0))[0]?.color;
    await expect(
      rollback.transaction(() =>
        Promise.all([
          rollback.setClipProps(clipAt(rollback, 0, 0), { color: 999 }),
          rollback.deleteTrack(unknownTrack()),
        ]),
      ),
    ).rejects.toBeDefined();
    expect(rollback.listClips(trackAt(rollback, 0))[0]?.color).toBe(before);
    expect(rollback.transactionCount).toBe(0);
  });
  it('keeps all fixture details available through dynamic refs', async () => {
    const session = FakeLiveBridge.seededSession();
    expect(session.listScenes().map((scene) => scene.name)).toEqual(['Intro', 'Verse', 'Chorus']);
    expect(
      session.listClips(trackAt(session, 0)).filter((clip) => clip.kind !== 'empty'),
    ).toHaveLength(3);
    expect(session.listClips(trackAt(session, 1))[0]?.kind).toBe('empty');
    expect(session.listClips(trackAt(session, 1))[1]).toMatchObject({
      kind: 'audio',
      filePath: '/audio/verse_beat.wav',
    });
    const messy = FakeLiveBridge.seededMessySet();
    expect(messy.listTracks().map((track) => track.name)).toEqual(['Bass', '1-MIDI', 'Empty']);
    expect(messy.listClips(trackAt(messy, 2)).every((clip) => clip.kind === 'empty')).toBe(true);
    expect(messy.listClips(trackAt(messy, 0))[0]?.color).toBe(12345);
    expect(messy.listClips(trackAt(messy, 0))[1]).toMatchObject({
      name: 'Loop',
      loopEnd: 4,
      endMarker: 6,
    });
    const seeded = FakeLiveBridge.seeded();
    expect(seeded.listClips(trackAt(seeded, 0))[0]?.endMarker).toBe(4);
    expect(seeded.listClips(trackAt(seeded, 0))[1]).toMatchObject({ kind: 'empty', endMarker: 0 });
    const audio = FakeLiveBridge.seededAudioTrack();
    expect((await audio.getTrackMixer(trackAt(audio, 0))).volume.value).toBe(0.6);
    expect(audio.firstMixerVolumeId).toMatch(/^lhref_param_/);
  });
});

describe('retained independent bridge contracts', () => {
  it('a mixer-volume setParam commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    await bridge.setParam((await bridge.getTrackMixer(trackAt(bridge, 0))).volume.id, 0.7);
    expect(bridge.transactionCount).toBe(1);
  });
  it('setParam on the volume id clamps to the parameter range (BAD_INPUT out of range)', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    await expect(
      bridge.setParam((await bridge.getTrackMixer(trackAt(bridge, 0))).volume.id, 2),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    expect(bridge.transactionCount).toBe(0);
  });
  it('getTrackMixer on an unknown track rejects with STALE_REFERENCE', async () => {
    await expect(FakeLiveBridge.seeded().getTrackMixer(unknownTrack())).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
    );
  });
  it('writes only the keys present (partial patch)', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect((await bridge.setClipProps(clipAt(bridge, 1, 0), { name: 'Sub' })).color).toBe(255);
  });
  it('works on an arrangement clip too', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect((await bridge.setClipProps(arrangementAt(bridge, 1), { color: 999 })).location).toBe(
      'arrangement',
    );
  });
  it('removes the track and shifts the list', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.deleteTrack(trackAt(bridge, 1));
    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Drums', 'Vocals']);
  });
  it('throws STALE_REFERENCE for an unknown track and WRONG_TYPE for a non-track id', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.deleteTrack(unknownTrack())).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
    );
    await expect(bridge.deleteTrack(slotAt(bridge, 0, 0) as unknown as TrackId)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'),
    );
  });
  it('splices an arrangement clip out of the track', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.deleteClip(arrangementAt(bridge, 1));
    expect(
      bridge.listClips(trackAt(bridge, 1)).filter((clip) => clip.location === 'arrangement'),
    ).toHaveLength(0);
  });
  it('deleteClip commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.deleteClip(clipAt(bridge, 0, 0));
    expect(bridge.transactionCount).toBe(1);
  });
  it('deleting an already-empty session slot has no usable clip ref and fails closed', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.deleteClip(slotAt(bridge, 0, 1) as unknown as ClipId)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'),
    );
  });
  it('appends an empty MIDI clip at the start beat and returns its ClipInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect(await bridge.createArrangementMidiClip(trackAt(bridge, 1), 16, 8)).toMatchObject({
      kind: 'midi',
      location: 'arrangement',
      startTime: 16,
      duration: 8,
      endTime: 24,
    });
  });
  it('createArrangementMidiClip commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.createArrangementMidiClip(trackAt(bridge, 0), 0, 4);
    expect(bridge.transactionCount).toBe(1);
  });
  it('appends an audio clip carrying its filePath and returns its ClipInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect(
      await bridge.createArrangementAudioClip(trackAt(bridge, 2), {
        filePath: '/audio/gtr.wav',
        startTime: 8,
        duration: 4,
      }),
    ).toMatchObject({ kind: 'audio', filePath: '/audio/gtr.wav', startTime: 8, duration: 4 });
  });
  it('createArrangementAudioClip commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.createArrangementAudioClip(trackAt(bridge, 2), AUDIO_ARGS);
    expect(bridge.transactionCount).toBe(1);
  });
  it('removes a clip fully inside the range', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.clearClipsInRange(trackAt(bridge, 1), 0, 8);
    expect(
      bridge.listClips(trackAt(bridge, 1)).filter((clip) => clip.location === 'arrangement'),
    ).toHaveLength(0);
  });
  it('truncates a clip that overlaps a boundary rather than deleting it', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.clearClipsInRange(trackAt(bridge, 1), 4, 8);
    expect(
      bridge.listClips(trackAt(bridge, 1)).filter((clip) => clip.location === 'arrangement')[0],
    ).toMatchObject({ startTime: 0, duration: 4, endTime: 4 });
  });
  it('leaves a clip fully outside the range untouched', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.clearClipsInRange(trackAt(bridge, 1), 16, 24);
    expect(
      bridge.listClips(trackAt(bridge, 1)).filter((clip) => clip.location === 'arrangement')[0]
        ?.duration,
    ).toBe(8);
  });
  it('clearClipsInRange commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.clearClipsInRange(trackAt(bridge, 1), 0, 8);
    expect(bridge.transactionCount).toBe(1);
  });
  it('creates a cue point at the beat with the name and returns its CuePointInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect(await bridge.createCuePoint(16, 'Chorus')).toMatchObject({ time: 16, name: 'Chorus' });
    expect(bridge.getSongOverview().cuePointCount).toBe(1);
  });
  it('keeps cue points ordered by beat', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.createCuePoint(32, 'Outro');
    expect((await bridge.createCuePoint(8, 'Intro')).id).toMatch(/^lhref_cue_/);
  });
  it('createCuePoint commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.createCuePoint(4, 'A');
    expect(bridge.transactionCount).toBe(1);
  });
  it('a Session-to-Song-style build (clear + creates + cue points) is one undo', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await bridge.transaction(() =>
      Promise.all([
        bridge.clearClipsInRange(trackAt(bridge, 0), 0, 64),
        bridge.createArrangementMidiClip(trackAt(bridge, 0), 0, 16),
        bridge.createCuePoint(0, 'Intro'),
      ]),
    );
    expect(bridge.transactionCount).toBe(1);
  });
  it('a Set-Janitor-style sweep (recolors + delete) is one undo', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    await bridge.transaction(() =>
      Promise.all([
        bridge.setClipProps(clipAt(bridge, 0, 0), { color: 16711680 }),
        bridge.setTrackProps(trackAt(bridge, 1), { name: 'Keys' }),
        bridge.deleteTrack(trackAt(bridge, 2)),
      ]),
    );
    expect(bridge.transactionCount).toBe(1);
  });
  it('rolls the whole sweep back on any rejection and commits no undo step', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const color = bridge.listClips(trackAt(bridge, 0))[0]?.color;
    await expect(
      bridge.transaction(() =>
        Promise.all([
          bridge.setClipProps(clipAt(bridge, 0, 0), { color: 999 }),
          bridge.deleteTrack(unknownTrack()),
        ]),
      ),
    ).rejects.toBeDefined();
    expect(bridge.listClips(trackAt(bridge, 0))[0]?.color).toBe(color);
    expect(bridge.transactionCount).toBe(0);
  });
  it('seededSession exposes scenes and per-scene session clips for the planner', () => {
    const bridge = FakeLiveBridge.seededSession();
    expect(bridge.listScenes().map((scene) => scene.name)).toEqual(['Intro', 'Verse', 'Chorus']);
    expect(
      bridge.listClips(trackAt(bridge, 0)).filter((clip) => clip.kind !== 'empty'),
    ).toHaveLength(3);
  });
  it('seededMessySet plants an empty track, placeholder names, off-palette color, loop overrun', () => {
    const bridge = FakeLiveBridge.seededMessySet();
    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Bass', '1-MIDI', 'Empty']);
    expect(bridge.listClips(trackAt(bridge, 0))[1]).toMatchObject({
      name: 'Loop',
      loopEnd: 4,
      endMarker: 6,
    });
  });
  it('listClips surfaces endMarker on clips and reports 0 for empty slots', () => {
    const bridge = FakeLiveBridge.seeded();
    expect(bridge.listClips(trackAt(bridge, 0))[0]?.endMarker).toBe(4);
    expect(bridge.listClips(trackAt(bridge, 0))[1]).toMatchObject({ kind: 'empty', endMarker: 0 });
  });
});
