/** Contract tests for the opaque-reference FakeLiveBridge seam. */

import { describe, expect, it } from 'vitest';

import { isPlayableClip, type NoteDTO } from '../dtos.js';
import { isBridgeErrorOfCode } from '../errors.js';
import { FakeLiveBridge } from '../fake-live-bridge.js';
import type { ClipId, ClipSlotId, TrackId } from '../ids.js';
import type { LiveBridge } from '../live-bridge.js';
import { makeSessionReference } from '../references.js';

function trackAt(bridge: FakeLiveBridge, index: number): TrackId {
  return bridge.listTracks()[index]!.id;
}

function clipAt(bridge: FakeLiveBridge, trackIndex: number, clipIndex: number): ClipId {
  const clip = bridge.listClips(trackAt(bridge, trackIndex))[clipIndex]!;
  if (!isPlayableClip(clip)) throw new Error('Expected a populated clip');
  return clip.id;
}

function slotAt(bridge: FakeLiveBridge, trackIndex: number, clipIndex: number): ClipSlotId {
  const slotId = bridge.listClips(trackAt(bridge, trackIndex))[clipIndex]!.slotId;
  if (slotId === undefined) throw new Error('Expected a session slot');
  return slotId;
}

function arrangementAt(bridge: FakeLiveBridge, trackIndex: number, index = 0): ClipId {
  const clip = bridge
    .listClips(trackAt(bridge, trackIndex))
    .filter(isPlayableClip)
    .filter((item) => item.location === 'arrangement')[index]!;
  return clip.id;
}

function unknownTrack(): TrackId {
  return makeSessionReference('track', 'unknowntrackref0001');
}

describe('FakeLiveBridge: synchronous getters', () => {
  it('getSongOverview returns a value directly, not a Promise', () => {
    const bridge: LiveBridge = FakeLiveBridge.seeded();
    const overview = bridge.getSongOverview();
    expect(overview).not.toBeInstanceOf(Promise);
    expect(overview.tempo).toBe(124);
    expect(overview.trackCount).toBe(3);
    expect(overview.tracks.map((track) => track.name)).toEqual(['Drums', 'Bass', 'Vocals']);
    expect(overview.tracks[2]?.type).toBe('audio');
    expect(overview.tracks[0]?.id).toMatch(/^lhref_trk_/);
  });

  it('listTracks / listClips / getNotes are synchronous reads', () => {
    const bridge = FakeLiveBridge.seeded();
    expect(bridge.listTracks()[0]?.name).toBe('Drums');
    const clips = bridge.listClips(trackAt(bridge, 0));
    expect(clips[0]?.location).toBe('session');
    expect(clips[0]?.kind).toBe('midi');
    expect(clips[0]?.slotId).toBe(slotAt(bridge, 0, 0));
    expect(clips.some((clip) => clip.kind === 'empty')).toBe(true);
    const notes = bridge.getNotes(clipAt(bridge, 0, 0));
    expect(notes).not.toBeInstanceOf(Promise);
    expect(notes).toHaveLength(4);
  });

  it('findTrack matches case-insensitively and returns no match without throwing', () => {
    const bridge = FakeLiveBridge.seeded();
    const bass = bridge.findTrack('bas');
    expect(bass.map((track) => track.name)).toEqual(['Bass']);
    expect(bass[0]).toEqual({ id: trackAt(bridge, 1), name: 'Bass', type: 'midi' });
    expect(bridge.findTrack('VOCAL').map((track) => track.name)).toEqual(['Vocals']);
    expect(bridge.findTrack('nope')).toEqual([]);
  });
});

describe('FakeLiveBridge: async parameter reads', () => {
  it('lists addressable parameter refs', async () => {
    const bridge = FakeLiveBridge.seeded();
    const params = await bridge.listDeviceParams(trackAt(bridge, 2));
    expect(params).toHaveLength(2);
    expect(params.every((param) => /^lhref_param_/.test(param.id))).toBe(true);
    expect(params[0]?.name).toBe('1 Frequency A');
  });

  it('listDeviceParams is a pure read', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.listDeviceParams(trackAt(bridge, 2));
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects an unknown track ref', async () => {
    await expect(FakeLiveBridge.seeded().listDeviceParams(unknownTrack())).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
    );
  });
});

describe('FakeLiveBridge: mutators return post-write DTOs', () => {
  it('setTempo returns a Promise and updated overview', async () => {
    const bridge = FakeLiveBridge.seeded();
    const result = bridge.setTempo(90);
    expect(result).toBeInstanceOf(Promise);
    expect((await result).tempo).toBe(90);
    expect(bridge.getSongOverview().tempo).toBe(90);
  });

  it('setTrackProps returns the changed track', async () => {
    const bridge = FakeLiveBridge.seeded();
    const info = await bridge.setTrackProps(trackAt(bridge, 0), { name: 'Kit', mute: true });
    expect(info.name).toBe('Kit');
    expect(info.mute).toBe(true);
    expect(bridge.listTracks()[0]?.name).toBe('Kit');
  });

  it('createTrack returns a fresh resolvable ref', async () => {
    const bridge = FakeLiveBridge.seeded();
    const info = await bridge.createTrack('midi');
    expect(info.kind).toBe('midi');
    expect(() => bridge.listClips(info.id)).not.toThrow();
    expect(bridge.listTracks()).toHaveLength(4);
  });

  it('createMidiClip fills a discovered empty session slot', async () => {
    const bridge = FakeLiveBridge.seeded();
    const clip = await bridge.createMidiClip(slotAt(bridge, 0, 1), 4);
    expect(clip.kind).toBe('midi');
    expect(clip.duration).toBe(4);
    expect(bridge.getNotes(clip.id as ClipId)).toEqual([]);
  });

  it('insertDevice returns writable parameter refs', async () => {
    const bridge = FakeLiveBridge.seeded();
    const device = await bridge.insertDevice(trackAt(bridge, 1), 'Reverb', 0);
    expect(device.name).toBe('Reverb');
    expect(device.parameters[0]?.id).toMatch(/^lhref_param_/);
  });

  it('setParam round-trips and rejects an out-of-range value', async () => {
    const bridge = FakeLiveBridge.seeded();
    const parameter = (await bridge.insertDevice(trackAt(bridge, 1), 'Reverb', 0)).parameters[0]!
      .id;
    expect((await bridge.setParam(parameter, 0.75)).value).toBe(0.75);
    await expect(bridge.setParam(parameter, 9)).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
  });

  it('renders an audio track without creating an undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect(await bridge.renderTrack(trackAt(bridge, 2), 0, 8)).toMatchObject({
      track: 'Vocals',
      path: '/tmp/loophole/render/Vocals_0-8.wav',
    });
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects rendering a non-audio track', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.renderTrack(trackAt(bridge, 0), 0, 8)).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'WRONG_TYPE'),
    );
  });
});

describe('FakeLiveBridge: MIDI snapshots and error contracts', () => {
  it('clones note reads', () => {
    const bridge = FakeLiveBridge.seeded();
    const id = clipAt(bridge, 0, 0);
    const notes = bridge.getNotes(id) as NoteDTO[];
    notes[0] = { pitch: 0, startTime: 0, duration: 0 };
    expect(bridge.getNotes(id)[0]?.pitch).toBe(36);
  });

  it('replaces notes, clamps values, and preserves input', async () => {
    const bridge = FakeLiveBridge.seeded();
    const id = clipAt(bridge, 0, 0);
    const input: readonly NoteDTO[] = [
      { pitch: 200, startTime: 0, duration: 1, velocity: 999 },
      { pitch: -5, startTime: 1, duration: 1, velocity: -3 },
    ];
    expect(await bridge.setNotes(id, input)).toEqual({ id, name: 'Beat', count: 2 });
    expect(bridge.getNotes(id)).toMatchObject([
      { pitch: 127, velocity: 127 },
      { pitch: 0, velocity: 0 },
    ]);
    expect(input[0]?.pitch).toBe(200);
    expect(input[0]?.velocity).toBe(999);
  });

  it('rejects unknown, empty-slot, and non-MIDI clip references appropriately', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.listClips(unknownTrack())),
        'STALE_REFERENCE',
      ),
    ).toBe(true);
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.getNotes(slotAt(bridge, 2, 0) as unknown as ClipId)),
        'WRONG_TYPE',
      ),
    ).toBe(true);
    const audioClip = arrangementAt(bridge, 2);
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.getNotes(audioClip)),
        'WRONG_TYPE',
      ),
    ).toBe(true);
    await expect(bridge.setNotes(audioClip, [])).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'WRONG_TYPE'),
    );
  });

  it('makes deleted refs stale and does not revive them in a replacement slot', async () => {
    const bridge = FakeLiveBridge.seeded();
    const id = clipAt(bridge, 0, 0);
    const slot = slotAt(bridge, 0, 0);
    await bridge.deleteClip(id);
    await expect(bridge.deleteClip(id)).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
    );
    const replacement = await bridge.createMidiClip(slot, 4);
    expect(replacement.id).not.toBe(id);
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.getNotes(id)),
        'STALE_REFERENCE',
      ),
    ).toBe(true);
  });

  it('bounds opaque-reference churn and never revives a deleted track ref', async () => {
    const bridge = new FakeLiveBridge(undefined, { referenceCapacity: 4 });
    const deleted: TrackId[] = [];

    for (let index = 0; index < 12; index += 1) {
      const created = await bridge.createTrack('midi');
      deleted.push(created.id);
      await bridge.deleteTrack(created.id);
    }

    expect(bridge.listTracks()).toHaveLength(3);
    expect(() => bridge.listClips(trackAt(bridge, 0))).not.toThrow();
    for (const id of deleted) {
      await expect(bridge.deleteTrack(id)).rejects.toSatisfy((error: unknown) =>
        isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
      );
    }
  });

  it('keeps a resolved live track ref canonical across bounded registry churn', async () => {
    const bridge = new FakeLiveBridge(undefined, { referenceCapacity: 4 });
    const [trackA] = bridge.listTracks();
    if (trackA === undefined) throw new Error('Expected seeded track A');

    await bridge.getTrackMixer(trackA.id);
    await bridge.createTrack('midi');
    const updated = await bridge.setTrackProps(trackA.id, { name: 'Canonical A' });

    expect(updated.id).toBe(trackA.id);
    expect(bridge.listClips(trackA.id)).toBeDefined();
    expect(bridge.findTrack('canonical').map((track) => track.id)).toEqual([trackA.id]);
  });

  it('rejects occupied and audio session slots, unknown device names, and wrong kinds', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.createMidiClip(slotAt(bridge, 0, 0), 4)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'SDK_REJECTED'),
    );
    await expect(bridge.createMidiClip(slotAt(bridge, 2, 0), 4)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'),
    );
    await expect(bridge.insertDevice(trackAt(bridge, 0), 'NotARealDevice', 0)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'SDK_REJECTED'),
    );
    await expect(bridge.deleteClip(trackAt(bridge, 0) as unknown as ClipId)).rejects.toSatisfy(
      (error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'),
    );
  });
});

describe('FakeLiveBridge: transaction and rollback contract', () => {
  it('commits every standalone mutation once and failed mutations never commit', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.setTempo(140);
    await bridge.setTrackProps(trackAt(bridge, 0), { name: 'Kit' });
    await bridge.setNotes(clipAt(bridge, 0, 0), [{ pitch: 60, startTime: 0, duration: 1 }]);
    expect(bridge.transactionCount).toBe(3);
    await expect(bridge.setTempo(-1)).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
    expect(bridge.transactionCount).toBe(3);
  });

  it('batches mutations into one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.transaction(() =>
      Promise.all([
        bridge.setTempo(140),
        bridge.setTrackProps(trackAt(bridge, 0), { name: 'Kit' }),
      ]),
    );
    expect(bridge.getSongOverview().tempo).toBe(140);
    expect(bridge.listTracks()[0]?.name).toBe('Kit');
    expect(bridge.transactionCount).toBe(1);
  });

  it('rolls back all state and undo count when one grouped mutation rejects', async () => {
    const bridge = FakeLiveBridge.seeded();
    const tempo = bridge.getSongOverview().tempo;
    const name = bridge.listTracks()[0]?.name;
    await expect(
      bridge.transaction(() =>
        Promise.all([
          bridge.setTempo(150),
          bridge.setTrackProps(trackAt(bridge, 0), { name: 'WillRollBack' }),
          bridge.setNotes(makeSessionReference('clip', 'unknownclipref00001'), []),
        ]),
      ),
    ).rejects.toBeDefined();
    expect(bridge.getSongOverview().tempo).toBe(tempo);
    expect(bridge.listTracks()[0]?.name).toBe(name);
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects non-Promise, async, and nested callbacks without leaking state', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(
      bridge.transaction((() => undefined) as unknown as () => Promise<void>),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    await expect(
      bridge.transaction(async () => {
        await bridge.setTempo(170);
        return 0;
      }),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    await expect(
      bridge.transaction(() => bridge.transaction(() => Promise.resolve(1))),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    expect(bridge.getSongOverview().tempo).toBe(124);
    expect(bridge.transactionCount).toBe(0);
  });
});

describe('FakeLiveBridge: fixture affordances', () => {
  it('withOneMidiClip exposes dynamic first clip and slot refs', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip([{ pitch: 60, startTime: 0, duration: 1 }]);
    expect(bridge.firstClipId).toMatch(/^lhref_clip_/);
    expect(bridge.firstSlotId).toMatch(/^lhref_slot_/);
    expect(bridge.firstClip().id).toBe(bridge.firstClipId);
    await bridge.setNotes(bridge.firstClipId, [{ pitch: 67, startTime: 0, duration: 1 }]);
    expect(bridge.firstClip().notes[0]?.pitch).toBe(67);
  });
});

describe('FakeLiveBridge: retained independent contracts', () => {
  it('unknown track id throws STALE_REFERENCE', () => {
    expect(
      isBridgeErrorOfCode(
        captured(() => FakeLiveBridge.seeded().listClips(unknownTrack())),
        'STALE_REFERENCE',
      ),
    ).toBe(true);
  });

  it('deleting state then re-reading an old arrangement clip ref throws STALE_REFERENCE', async () => {
    const bridge = FakeLiveBridge.seeded();
    const id = arrangementAt(bridge, 1);
    await bridge.deleteClip(id);
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.getNotes(id)),
        'STALE_REFERENCE',
      ),
    ).toBe(true);
  });

  it('reading an empty session-slot ref as a clip fails closed with WRONG_TYPE', () => {
    const bridge = FakeLiveBridge.seeded();
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.getNotes(slotAt(bridge, 2, 0) as unknown as ClipId)),
        'WRONG_TYPE',
      ),
    ).toBe(true);
  });

  it('setNotes on a valid MIDI clip replaces and reports the count', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip([{ pitch: 60, startTime: 0, duration: 1 }]);
    expect(
      (await bridge.setNotes(bridge.firstClipId, [{ pitch: 64, startTime: 0, duration: 1 }])).count,
    ).toBe(1);
  });

  it('a failed mutation commits no undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.setTempo(-1)).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
    expect(bridge.transactionCount).toBe(0);
  });

  it('renderTrack does not commit an undo step (it produces a file, not a change)', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.renderTrack(trackAt(bridge, 2), 0, 8);
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects a callback that does not return a Promise (sync-callback rule)', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(
      bridge.transaction((() => undefined) as unknown as () => Promise<void>),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    expect(bridge.getSongOverview().tempo).toBe(124);
  });

  it('rejects an async callback (you cannot await inside withinTransaction)', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(
      bridge.transaction(async () => {
        await bridge.setTempo(170);
        return 0;
      }),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects a nested transaction with BAD_INPUT', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(
      bridge.transaction(() => bridge.transaction(() => Promise.resolve(1))),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
  });

  it('withOneMidiClip exposes firstClipId / firstSlotId / firstClip() on the instance', () => {
    const bridge = FakeLiveBridge.withOneMidiClip([{ pitch: 60, startTime: 0, duration: 1 }]);
    expect(bridge.firstClip().id).toBe(bridge.firstClipId);
    expect(bridge.firstClip().notes[0]?.pitch).toBe(60);
  });

  it('firstClip() reflects a write through setNotes', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip([{ pitch: 60, startTime: 0, duration: 1 }]);
    await bridge.setNotes(bridge.firstClipId, [{ pitch: 67, startTime: 0, duration: 1 }]);
    expect(bridge.firstClip().notes[0]?.pitch).toBe(67);
  });
});

function captured(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}
