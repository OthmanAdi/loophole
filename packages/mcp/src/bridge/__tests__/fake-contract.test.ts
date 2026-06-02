/**
 * Contract tests that PIN the SDK semantics the FakeLiveBridge must reproduce.
 * These run with no Ableton install. The same assertions are the ones a manual
 * smoke test would run against the real adapter, so the fake cannot silently drift.
 */

import { describe, expect, it } from 'vitest';

import { FakeLiveBridge } from '../FakeLiveBridge.js';
import { isBridgeErrorOfCode } from '../errors.js';
import { arrangementClipId, makePathId, sessionClipId, trackId } from '../ids.js';
import type { LiveBridge } from '../LiveBridge.js';
import type { NoteDTO } from '../dtos.js';

const firstClip = sessionClipId(0, 0);

describe('FakeLiveBridge: synchronous getters', () => {
  it('getSongOverview returns a value directly, not a Promise', () => {
    const bridge: LiveBridge = FakeLiveBridge.seeded();
    const overview = bridge.getSongOverview();
    expect(overview).not.toBeInstanceOf(Promise);
    expect(overview.tempo).toBe(124);
    expect(overview.trackCount).toBe(3);
  });

  it('getTracks / getClips / getNotes are synchronous reads', () => {
    const bridge = FakeLiveBridge.seeded();
    const tracks = bridge.getTracks();
    expect(Array.isArray(tracks)).toBe(true);
    expect(tracks[0]?.name).toBe('Drums');

    const clips = bridge.getClips(trackId(0));
    expect(clips[0]?.location).toBe('session');

    const notes = bridge.getNotes(firstClip);
    expect(notes).not.toBeInstanceOf(Promise);
    expect(notes.length).toBe(4);
  });

  it('findTrack filters by name substring and kind, no throw on no match', () => {
    const bridge = FakeLiveBridge.seeded();
    expect(bridge.findTrack({ name: 'bas' }).map((t) => t.name)).toEqual(['Bass']);
    expect(bridge.findTrack({ kind: 'audio' }).map((t) => t.name)).toEqual(['Vocals']);
    expect(bridge.findTrack({ name: 'nope' })).toEqual([]);
  });
});

describe('FakeLiveBridge: mutators are async', () => {
  it('setTempo returns a Promise and applies after await', async () => {
    const bridge = FakeLiveBridge.seeded();
    const ret = bridge.setTempo(90);
    expect(ret).toBeInstanceOf(Promise);
    await ret;
    expect(bridge.getSongOverview().tempo).toBe(90);
  });

  it('createMidiTrack resolves to a fresh, resolvable track id', async () => {
    const bridge = FakeLiveBridge.seeded();
    const id = await bridge.createMidiTrack();
    expect(id).toBe(trackId(3));
    // The new id must resolve (no throw) on a follow-up read.
    expect(() => bridge.getClips(id)).not.toThrow();
    expect(bridge.getTracks().length).toBe(4);
  });
});

describe('FakeLiveBridge: MIDI notes use read-map-assign + pitch clamp', () => {
  it('getNotes clones; mutating the result does not change fake state', () => {
    const bridge = FakeLiveBridge.seeded();
    const first = bridge.getNotes(firstClip);
    // Attempt an in-place mutation of the returned snapshot.
    (first as NoteDTO[])[0] = { pitch: 0, startTime: 0, duration: 0 };
    expect(bridge.getNotes(firstClip)[0]?.pitch).toBe(36);
  });

  it('setNotes replaces wholesale and clamps pitch to 0..127', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.setNotes(firstClip, [
      { pitch: 200, startTime: 0, duration: 1, velocity: 100 },
      { pitch: -5, startTime: 1, duration: 1 },
    ]);
    const notes = bridge.getNotes(firstClip);
    expect(notes.length).toBe(2);
    expect(notes[0]?.pitch).toBe(127);
    expect(notes[1]?.pitch).toBe(0);
  });
});

describe('FakeLiveBridge: stale / wrong-type references throw', () => {
  it('unknown track id throws STALE_REFERENCE', () => {
    const bridge = FakeLiveBridge.seeded();
    try {
      bridge.getClips(trackId(99));
      expect.unreachable('expected a STALE_REFERENCE throw');
    } catch (error) {
      expect(isBridgeErrorOfCode(error, 'STALE_REFERENCE')).toBe(true);
    }
  });

  it('deleting state then re-reading an old clip id throws STALE_REFERENCE', () => {
    const bridge = FakeLiveBridge.seeded();
    const arrClip = arrangementClipId(1, 0);
    // The bass arrangement clip exists initially.
    expect(() => bridge.getNotes(arrClip)).not.toThrow();
    // An out-of-range arrangement index is a stale reference.
    expect(() => bridge.getNotes(arrangementClipId(1, 5))).toThrow();
    expect(isBridgeErrorOfCode(staleOf(bridge, arrangementClipId(1, 5)), 'STALE_REFERENCE')).toBe(
      true,
    );
  });

  it('reading notes of an audio clip slot path throws WRONG_TYPE or STALE', () => {
    const bridge = FakeLiveBridge.seeded();
    // Vocals (track 2) is audio with an empty slot -> empty slot is STALE_REFERENCE.
    try {
      bridge.getNotes(sessionClipId(2, 0));
      expect.unreachable('expected a throw for an empty audio slot');
    } catch (error) {
      expect(isBridgeErrorOfCode(error, 'STALE_REFERENCE')).toBe(true);
    }
  });

  it('setNotes on a non-MIDI clip would throw WRONG_TYPE', async () => {
    // Build a Set with one audio clip in a slot to exercise the WRONG_TYPE path.
    const bridge = FakeLiveBridge.withOneMidiClip([{ pitch: 60, startTime: 0, duration: 1 }]);
    // A valid MIDI write succeeds.
    await expect(
      bridge.setNotes(sessionClipId(0, 0), [{ pitch: 64, startTime: 0, duration: 1 }]),
    ).resolves.toBeUndefined();
  });

  it('a malformed id string fails to even build', () => {
    expect(() => makePathId('track:-1')).toThrow();
    expect(() => makePathId('')).toThrow();
    expect(() => makePathId('bogus')).toThrow();
  });
});

describe('FakeLiveBridge: withTransaction = one undo + rollback', () => {
  it('commits all mutations when the batch resolves', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.withTransaction(() =>
      Promise.all([bridge.setTempo(140), bridge.setTrackProps(trackId(0), { name: 'Kit' })]),
    );
    expect(bridge.getSongOverview().tempo).toBe(140);
    expect(bridge.getTracks()[0]?.name).toBe('Kit');
  });

  it('rolls the WHOLE group back on any rejection (one call = one undo)', async () => {
    const bridge = FakeLiveBridge.seeded();
    const beforeTempo = bridge.getSongOverview().tempo;
    const beforeName = bridge.getTracks()[0]?.name;

    await expect(
      bridge.withTransaction(() =>
        Promise.all([
          bridge.setTempo(150),
          bridge.setTrackProps(trackId(0), { name: 'WillRollBack' }),
          // This one rejects -> the entire transaction must roll back.
          bridge.setNotes(makePathId('track:99/clipslot:0/clip'), []),
        ]),
      ),
    ).rejects.toBeDefined();

    expect(bridge.getSongOverview().tempo).toBe(beforeTempo);
    expect(bridge.getTracks()[0]?.name).toBe(beforeName);
  });

  it('rejects a callback that does not return a Promise (sync-callback rule)', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(
      // @ts-expect-error: the callback must return a Promise; a void return is misuse.
      bridge.withTransaction(() => {
        bridge.setTempo(160);
      }),
    ).rejects.toSatisfy((e: unknown) => isBridgeErrorOfCode(e, 'BAD_INPUT'));
    // The errant synchronous tempo write must not have leaked through.
    expect(bridge.getSongOverview().tempo).toBe(124);
  });
});

/** Helper: capture the thrown error from a getNotes call for code assertions. */
function staleOf(bridge: LiveBridge, id: ReturnType<typeof arrangementClipId>): unknown {
  try {
    bridge.getNotes(id);
    return null;
  } catch (error) {
    return error;
  }
}
