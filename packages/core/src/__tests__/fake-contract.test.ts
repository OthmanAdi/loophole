/**
 * Contract tests that PIN the SDK semantics the FakeLiveBridge must reproduce, on
 * the evolved port that backs the 12 Loophole Bridge tools. These run with no
 * Ableton install. The same assertions are the ones a manual smoke test would run
 * against the real adapter, so the fake cannot silently drift.
 */

import { describe, expect, it } from 'vitest';

import { FakeLiveBridge } from '../fake-live-bridge.js';
import { isBridgeErrorOfCode } from '../errors.js';
import {
  arrangementClipId,
  clipSlotId,
  makePathId,
  paramId,
  sessionClipId,
  trackId,
} from '../ids.js';
import type { LiveBridge } from '../live-bridge.js';
import type { NoteDTO } from '../dtos.js';

const firstClip = sessionClipId(0, 0);

describe('FakeLiveBridge: synchronous getters', () => {
  it('getSongOverview returns a value directly, not a Promise', () => {
    const bridge: LiveBridge = FakeLiveBridge.seeded();
    const overview = bridge.getSongOverview();
    expect(overview).not.toBeInstanceOf(Promise);
    expect(overview.tempo).toBe(124);
    expect(overview.trackCount).toBe(3);
    // The overview carries the track list with ids + types (new in the evolved port).
    expect(overview.tracks.map((t) => t.name)).toEqual(['Drums', 'Bass', 'Vocals']);
    expect(overview.tracks[2]?.type).toBe('audio');
    expect(overview.tracks[0]?.id).toBe(trackId(0));
  });

  it('listTracks / listClips / getNotes are synchronous reads', () => {
    const bridge = FakeLiveBridge.seeded();
    const tracks = bridge.listTracks();
    expect(Array.isArray(tracks)).toBe(true);
    expect(tracks[0]?.name).toBe('Drums');

    const clips = bridge.listClips(trackId(0));
    // First entry is the Session clip in slot 0; slot 1 is reported as empty.
    expect(clips[0]?.location).toBe('session');
    expect(clips[0]?.kind).toBe('midi');
    expect(clips[0]?.slotId).toBe(clipSlotId(0, 0));
    expect(clips.some((c) => c.kind === 'empty')).toBe(true);

    const notes = bridge.getNotes(firstClip);
    expect(notes).not.toBeInstanceOf(Promise);
    expect(notes.length).toBe(4);
  });

  it('findTrack matches by name substring and returns {name,id,type}, no throw on no match', () => {
    const bridge = FakeLiveBridge.seeded();
    const bass = bridge.findTrack('bas');
    expect(bass.map((t) => t.name)).toEqual(['Bass']);
    expect(bass[0]).toEqual({ id: trackId(1), name: 'Bass', type: 'midi' });
    // Case-insensitive.
    expect(bridge.findTrack('VOCAL').map((t) => t.name)).toEqual(['Vocals']);
    expect(bridge.findTrack('nope')).toEqual([]);
  });
});

describe('FakeLiveBridge: async device-value reads (getValue is the one async getter)', () => {
  it('listDeviceParams resolves to addressable parameter ids', async () => {
    const bridge = FakeLiveBridge.seeded();
    // listDeviceParams is async: a parameter's live value comes from
    // DeviceParameter.getValue(), the one async SDK getter (01_SDK_MAP §2).
    // Vocals (track 2) has EQ Eight + Compressor, one param each.
    const params = await bridge.listDeviceParams(trackId(2));
    expect(params.length).toBe(2);
    expect(params[0]?.id).toBe(paramId(2, 0, 0));
    expect(params[1]?.id).toBe(paramId(2, 1, 0));
    expect(params[0]?.name).toBe('1 Frequency A');
  });

  it('listDeviceParams is a pure read: it adds no undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect(bridge.transactionCount).toBe(0);
    await bridge.listDeviceParams(trackId(2));
    expect(bridge.transactionCount).toBe(0);
  });

  it('listDeviceParams on an unknown track rejects with STALE_REFERENCE', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.listDeviceParams(trackId(99))).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'STALE_REFERENCE'),
    );
  });
});

describe('FakeLiveBridge: mutators are async and return the post-write DTO', () => {
  it('setTempo returns a Promise and resolves to the new overview', async () => {
    const bridge = FakeLiveBridge.seeded();
    const ret = bridge.setTempo(90);
    expect(ret).toBeInstanceOf(Promise);
    const overview = await ret;
    expect(overview.tempo).toBe(90);
    expect(bridge.getSongOverview().tempo).toBe(90);
  });

  it('setTrackProps resolves to the updated TrackInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    const info = await bridge.setTrackProps(trackId(0), { name: 'Kit', mute: true });
    expect(info.name).toBe('Kit');
    expect(info.mute).toBe(true);
    expect(bridge.listTracks()[0]?.name).toBe('Kit');
  });

  it('createTrack resolves to a fresh, resolvable TrackInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    const info = await bridge.createTrack('midi');
    expect(info.id).toBe(trackId(3));
    expect(info.kind).toBe('midi');
    // The new id must resolve (no throw) on a follow-up read.
    expect(() => bridge.listClips(info.id)).not.toThrow();
    expect(bridge.listTracks().length).toBe(4);
  });

  it('createMidiClip fills an empty session slot and returns the ClipInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Drums slot 1 is empty.
    const clip = await bridge.createMidiClip(clipSlotId(0, 1), 4);
    expect(clip.id).toBe(sessionClipId(0, 1));
    expect(clip.kind).toBe('midi');
    expect(clip.duration).toBe(4);
    expect(bridge.getNotes(clip.id)).toEqual([]);
  });

  it('insertDevice adds a known built-in device and returns addressable params', async () => {
    const bridge = FakeLiveBridge.seeded();
    const device = await bridge.insertDevice(trackId(1), 'Reverb', 0);
    expect(device.name).toBe('Reverb');
    expect(device.parameters[0]?.id).toBe(paramId(1, 0, 0));
    // The reported param id resolves for a follow-up setParam.
    const pid = device.parameters[0]?.id;
    expect(pid).toBeDefined();
  });

  it('setParam clamps to range and resolves to the post-write DeviceParamInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    const device = await bridge.insertDevice(trackId(1), 'Reverb', 0);
    const pid = device.parameters[0]!.id;
    const updated = await bridge.setParam(pid, 0.75);
    expect(updated.value).toBe(0.75);
    // Out of range is BAD_INPUT.
    await expect(bridge.setParam(pid, 9)).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'BAD_INPUT'),
    );
  });

  it('renderTrack returns a deterministic temp path for an audio track', async () => {
    const bridge = FakeLiveBridge.seeded();
    const result = await bridge.renderTrack(trackId(2), 0, 8);
    expect(result.track).toBe('Vocals');
    expect(result.path).toBe('/tmp/loophole/render/Vocals_0-8.wav');
  });

  it('renderTrack on a non-audio track throws WRONG_TYPE', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.renderTrack(trackId(0), 0, 8)).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'WRONG_TYPE'),
    );
  });
});

describe('FakeLiveBridge: MIDI notes use read-map-assign + pitch/velocity clamp', () => {
  it('getNotes clones; mutating the result does not change fake state', () => {
    const bridge = FakeLiveBridge.seeded();
    const first = bridge.getNotes(firstClip);
    // Attempt an in-place mutation of the returned snapshot.
    (first as NoteDTO[])[0] = { pitch: 0, startTime: 0, duration: 0 };
    expect(bridge.getNotes(firstClip)[0]?.pitch).toBe(36);
  });

  it('setNotes replaces wholesale, clamps pitch/velocity, reports count, never mutates input', async () => {
    const bridge = FakeLiveBridge.seeded();
    const input: readonly NoteDTO[] = [
      { pitch: 200, startTime: 0, duration: 1, velocity: 999 },
      { pitch: -5, startTime: 1, duration: 1, velocity: -3 },
    ];
    const result = await bridge.setNotes(firstClip, input);
    expect(result).toEqual({ id: firstClip, name: 'Beat', count: 2 });

    const notes = bridge.getNotes(firstClip);
    expect(notes.length).toBe(2);
    expect(notes[0]?.pitch).toBe(127);
    expect(notes[0]?.velocity).toBe(127);
    expect(notes[1]?.pitch).toBe(0);
    expect(notes[1]?.velocity).toBe(0);

    // Input objects are untouched (the read-map-assign / assign-back contract).
    expect(input[0]?.pitch).toBe(200);
    expect(input[0]?.velocity).toBe(999);
  });
});

describe('FakeLiveBridge: stale / wrong-type references throw', () => {
  it('unknown track id throws STALE_REFERENCE', () => {
    const bridge = FakeLiveBridge.seeded();
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.listClips(trackId(99))),
        'STALE_REFERENCE',
      ),
    ).toBe(true);
  });

  it('deleting state then re-reading an old clip id throws STALE_REFERENCE', () => {
    const bridge = FakeLiveBridge.seeded();
    const arrClip = arrangementClipId(1, 0);
    // The bass arrangement clip exists initially.
    expect(() => bridge.getNotes(arrClip)).not.toThrow();
    // An out-of-range arrangement index is a stale reference.
    expect(() => bridge.getNotes(arrangementClipId(1, 5))).toThrow();
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.getNotes(arrangementClipId(1, 5))),
        'STALE_REFERENCE',
      ),
    ).toBe(true);
  });

  it('reading notes of an empty audio clip slot path throws STALE_REFERENCE', () => {
    const bridge = FakeLiveBridge.seeded();
    // Vocals (track 2) is audio with an empty slot -> empty slot is STALE_REFERENCE.
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.getNotes(sessionClipId(2, 0))),
        'STALE_REFERENCE',
      ),
    ).toBe(true);
  });

  it('getNotes on a non-MIDI (audio) clip throws WRONG_TYPE', () => {
    const bridge = FakeLiveBridge.seeded();
    // Vocals (track 2) has one AUDIO arrangement clip at track:2/clip:0.
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.getNotes(arrangementClipId(2, 0))),
        'WRONG_TYPE',
      ),
    ).toBe(true);
  });

  it('setNotes on a non-MIDI (audio) clip throws WRONG_TYPE', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(
      bridge.setNotes(arrangementClipId(2, 0), [{ pitch: 64, startTime: 0, duration: 1 }]),
    ).rejects.toSatisfy((e: unknown) => isBridgeErrorOfCode(e, 'WRONG_TYPE'));
  });

  it('setNotes on a valid MIDI clip replaces and reports the count', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip([{ pitch: 60, startTime: 0, duration: 1 }]);
    const result = await bridge.setNotes(bridge.firstClipId, [
      { pitch: 64, startTime: 0, duration: 1 },
    ]);
    expect(result.count).toBe(1);
  });

  it('createMidiClip on an occupied slot throws SDK_REJECTED', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Drums slot 0 is occupied by "Beat".
    await expect(bridge.createMidiClip(clipSlotId(0, 0), 4)).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'SDK_REJECTED'),
    );
  });

  it('createMidiClip on an audio-track slot throws WRONG_TYPE', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Vocals (track 2) is an audio track; its slot cannot hold a created MIDI clip.
    await expect(bridge.createMidiClip(clipSlotId(2, 0), 4)).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'WRONG_TYPE'),
    );
  });

  it('insertDevice with an unknown device name throws SDK_REJECTED', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.insertDevice(trackId(0), 'NotARealDevice', 0)).rejects.toSatisfy(
      (e: unknown) => isBridgeErrorOfCode(e, 'SDK_REJECTED'),
    );
  });

  it('a malformed id string fails to even build', () => {
    expect(() => makePathId('track:-1')).toThrow();
    expect(() => makePathId('')).toThrow();
    expect(() => makePathId('bogus')).toThrow();
  });
});

describe('FakeLiveBridge: one tool call = one transaction = one undo', () => {
  it('each standalone mutation commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect(bridge.transactionCount).toBe(0);

    await bridge.setTempo(140);
    expect(bridge.transactionCount).toBe(1);

    await bridge.setTrackProps(trackId(0), { name: 'Kit' });
    expect(bridge.transactionCount).toBe(2);

    await bridge.setNotes(firstClip, [{ pitch: 60, startTime: 0, duration: 1 }]);
    expect(bridge.transactionCount).toBe(3);
  });

  it('a failed mutation commits no undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.setTempo(-1)).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'BAD_INPUT'),
    );
    expect(bridge.transactionCount).toBe(0);
  });

  it('renderTrack does not commit an undo step (it produces a file, not a change)', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.renderTrack(trackId(2), 0, 8);
    expect(bridge.transactionCount).toBe(0);
  });

  it('a transaction batching several mutations counts as ONE undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.transaction(() =>
      Promise.all([bridge.setTempo(140), bridge.setTrackProps(trackId(0), { name: 'Kit' })]),
    );
    expect(bridge.getSongOverview().tempo).toBe(140);
    expect(bridge.listTracks()[0]?.name).toBe('Kit');
    // Two mutations, one undo step.
    expect(bridge.transactionCount).toBe(1);
  });

  it('rolls the WHOLE group back on any rejection, and commits no undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    const beforeTempo = bridge.getSongOverview().tempo;
    const beforeName = bridge.listTracks()[0]?.name;

    await expect(
      bridge.transaction(() =>
        Promise.all([
          bridge.setTempo(150),
          bridge.setTrackProps(trackId(0), { name: 'WillRollBack' }),
          // This one rejects -> the entire transaction must roll back.
          bridge.setNotes(makePathId('track:99/clipslot:0/clip'), []),
        ]),
      ),
    ).rejects.toBeDefined();

    expect(bridge.getSongOverview().tempo).toBe(beforeTempo);
    expect(bridge.listTracks()[0]?.name).toBe(beforeName);
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects a callback that does not return a Promise (sync-callback rule)', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(
      // @ts-expect-error: the callback must return a Promise; a void return is misuse.
      bridge.transaction(() => {
        void bridge.setTempo(160);
      }),
    ).rejects.toSatisfy((e: unknown) => isBridgeErrorOfCode(e, 'BAD_INPUT'));
    // The errant tempo write must not have leaked through (rolled back), and no undo.
    expect(bridge.getSongOverview().tempo).toBe(124);
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects an async callback (you cannot await inside withinTransaction)', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(
      bridge.transaction(async () => {
        await bridge.setTempo(170);
        return 0;
      }),
    ).rejects.toSatisfy((e: unknown) => isBridgeErrorOfCode(e, 'BAD_INPUT'));
    expect(bridge.getSongOverview().tempo).toBe(124);
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects a nested transaction with BAD_INPUT', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(
      bridge.transaction(() => bridge.transaction(() => Promise.resolve(1))),
    ).rejects.toSatisfy((e: unknown) => isBridgeErrorOfCode(e, 'BAD_INPUT'));
  });
});

describe('FakeLiveBridge: factory + test affordances', () => {
  it('withOneMidiClip exposes firstClipId / firstSlotId / firstClip() on the instance', () => {
    const bridge = FakeLiveBridge.withOneMidiClip([{ pitch: 60, startTime: 0, duration: 1 }]);
    // Instance access (the 02_BRIDGE_SPEC §8 ring-2 consumption pattern: live.firstClipId).
    expect(bridge.firstClipId).toBe(sessionClipId(0, 0));
    expect(bridge.firstSlotId).toBe(clipSlotId(0, 0));
    const { id, notes } = bridge.firstClip();
    expect(id).toBe(bridge.firstClipId);
    expect(notes[0]?.pitch).toBe(60);
  });

  it('firstClip() reflects a write through setNotes (the spec ring-2 assertion)', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip([{ pitch: 60, startTime: 0, duration: 1 }]);
    await bridge.setNotes(bridge.firstClipId, [{ pitch: 67, startTime: 0, duration: 1 }]);
    expect(bridge.firstClip().notes[0]?.pitch).toBe(67);
  });
});

/** Capture the thrown error from a synchronous read for code assertions. */
function captured(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}
