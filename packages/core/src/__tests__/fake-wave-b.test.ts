/**
 * Wave B (stage 1) contract tests: the NEW LiveBridge port methods the five
 * extension handlers will read + transform + write the Set through, pinned against
 * the FakeLiveBridge with no Ableton install. Each new mutation commits exactly one
 * undo step (or the right count), stale / wrong-type ids throw the typed error, and
 * the mixer volume exposes a writable ParamId whose setParam round-trips.
 *
 * These sit alongside the Wave A `fake-contract.test.ts`; the same assertions are
 * the ones a manual smoke test would run against the real adapter, so the fake (and
 * the seam the stage-2 handlers depend on) cannot silently drift.
 */

import { describe, expect, it } from 'vitest';

import { FakeLiveBridge } from '../fake-live-bridge.js';
import { isBridgeErrorOfCode } from '../errors.js';
import {
  arrangementClipId,
  clipSlotId,
  cuePointId,
  mixerVolumeParamId,
  sceneId,
  sessionClipId,
  trackId,
} from '../ids.js';
import type { CreateAudioClipArgs } from '../dtos.js';

const AUDIO_ARGS: CreateAudioClipArgs = {
  filePath: '/audio/loop.wav',
  startTime: 0,
  duration: 8,
};

describe('getTrackMixer: exposes a writable volume ParamId that round-trips via setParam', () => {
  it('resolves to the volume parameter with min/max/defaultValue/value and a mixer id', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    // getTrackMixer is async (the real value comes from DeviceParameter.getValue()).
    const mixer = await bridge.getTrackMixer(trackId(0));
    expect(mixer.volume.id).toBe(mixerVolumeParamId(0));
    expect(mixer.volume.min).toBe(0);
    expect(mixer.volume.max).toBe(1);
    expect(mixer.volume.defaultValue).toBe(0.85);
    // seededAudioTrack starts the Gtr volume at 0.6.
    expect(mixer.volume.value).toBe(0.6);
  });

  it('the reported volume id is writable through setParam and the read reflects it', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const volumeId = (await bridge.getTrackMixer(trackId(0))).volume.id;

    const updated = await bridge.setParam(volumeId, 0.5);
    expect(updated.id).toBe(volumeId);
    expect(updated.value).toBe(0.5);
    // A fresh getTrackMixer read sees the persisted write (proves it mutates the
    // stored param by reference, not a throwaway snapshot).
    expect((await bridge.getTrackMixer(trackId(0))).volume.value).toBe(0.5);
  });

  it('a mixer-volume setParam commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    expect(bridge.transactionCount).toBe(0);
    await bridge.setParam(bridge.firstMixerVolumeId, 0.7);
    expect(bridge.transactionCount).toBe(1);
  });

  it('setParam on the volume id clamps to the parameter range (BAD_INPUT out of range)', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const volumeId = (await bridge.getTrackMixer(trackId(0))).volume.id;
    await expect(bridge.setParam(volumeId, 2)).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'BAD_INPUT'),
    );
    // The failed write left the value untouched and committed no undo step. A pure read
    // (getTrackMixer) does NOT add an undo step, so the count stays at zero.
    expect((await bridge.getTrackMixer(trackId(0))).volume.value).toBe(0.6);
    expect(bridge.transactionCount).toBe(0);
  });

  it('getTrackMixer works on any track (the mixer exists on MIDI tracks too)', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Drums (track 0) is a MIDI track; it still has a mixer volume.
    const mixer = await bridge.getTrackMixer(trackId(0));
    expect(mixer.volume.id).toBe(mixerVolumeParamId(0));
    expect(mixer.volume.value).toBe(0.85);
  });

  it('getTrackMixer on an unknown track rejects with STALE_REFERENCE', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Async read: a bad id surfaces as a rejected Promise (matching the real adapter,
    // whose resolveTrack throw inside an async method becomes a rejection).
    await expect(bridge.getTrackMixer(trackId(99))).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'STALE_REFERENCE'),
    );
  });

  it('getTrackMixer on a non-track id rejects with WRONG_TYPE', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.getTrackMixer(clipSlotId(0, 0))).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'WRONG_TYPE'),
    );
  });
});

describe('listScenes: surfaces the Set scenes for Session-to-Song', () => {
  it('returns scenes in order with ids, names, and signature', () => {
    const bridge = FakeLiveBridge.seededSession();
    const scenes = bridge.listScenes();
    expect(scenes).not.toBeInstanceOf(Promise);
    expect(scenes.map((s) => s.name)).toEqual(['Intro', 'Verse', 'Chorus']);
    expect(scenes[0]?.id).toBe(sceneId(0));
    expect(scenes[2]?.id).toBe(sceneId(2));
    expect(scenes[0]?.tempo).toBeNull();
    expect(scenes[0]?.signatureNumerator).toBe(4);
    expect(scenes[0]?.signatureDenominator).toBe(4);
  });

  it('the overview scene count matches listScenes length', () => {
    const bridge = FakeLiveBridge.seededSession();
    expect(bridge.getSongOverview().sceneCount).toBe(bridge.listScenes().length);
  });
});

describe('setClipProps: renames / recolors a clip in one undo (session or arrangement)', () => {
  it('sets name + color on a session clip and resolves to the post-write ClipInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    const id = sessionClipId(0, 0); // Drums "Beat"
    const info = await bridge.setClipProps(id, { name: 'Kick Loop', color: 123 });
    expect(info.id).toBe(id);
    expect(info.name).toBe('Kick Loop');
    expect(info.color).toBe(123);
    expect(info.location).toBe('session');
    expect(info.slotId).toBe(clipSlotId(0, 0));
    // The change is visible on a fresh list read.
    const listed = bridge.listClips(trackId(0))[0];
    expect(listed?.name).toBe('Kick Loop');
    expect(listed?.color).toBe(123);
  });

  it('writes only the keys present (partial patch)', async () => {
    const bridge = FakeLiveBridge.seeded();
    const id = sessionClipId(1, 0); // Bass "Bassline", color 255
    const info = await bridge.setClipProps(id, { name: 'Sub' });
    expect(info.name).toBe('Sub');
    expect(info.color).toBe(255); // unchanged
  });

  it('works on an arrangement clip too', async () => {
    const bridge = FakeLiveBridge.seeded();
    const id = arrangementClipId(1, 0); // Bass (arr)
    const info = await bridge.setClipProps(id, { color: 999 });
    expect(info.location).toBe('arrangement');
    expect(info.color).toBe(999);
    expect(info.slotId).toBeUndefined();
  });

  it('commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect(bridge.transactionCount).toBe(0);
    await bridge.setClipProps(sessionClipId(0, 0), { name: 'X' });
    expect(bridge.transactionCount).toBe(1);
  });

  it('throws STALE_REFERENCE for a missing clip and WRONG_TYPE for a non-clip id', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.setClipProps(arrangementClipId(1, 9), { name: 'X' })).rejects.toSatisfy(
      (e: unknown) => isBridgeErrorOfCode(e, 'STALE_REFERENCE'),
    );
    await expect(bridge.setClipProps(trackId(0), { name: 'X' })).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'WRONG_TYPE'),
    );
  });
});

describe('deleteTrack: removes a track in one undo', () => {
  it('removes the track and shifts the list', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect(bridge.listTracks().length).toBe(3);
    await bridge.deleteTrack(trackId(1)); // Bass
    const tracks = bridge.listTracks();
    expect(tracks.length).toBe(2);
    expect(tracks.map((t) => t.name)).toEqual(['Drums', 'Vocals']);
  });

  it('commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.deleteTrack(trackId(2));
    expect(bridge.transactionCount).toBe(1);
  });

  it('throws STALE_REFERENCE for an unknown track and WRONG_TYPE for a non-track id', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.deleteTrack(trackId(99))).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'STALE_REFERENCE'),
    );
    await expect(bridge.deleteTrack(clipSlotId(0, 0))).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'WRONG_TYPE'),
    );
  });
});

describe('deleteClip: removes a session or arrangement clip in one undo', () => {
  it('empties the slot for a session clip (the slot remains and reports empty)', async () => {
    const bridge = FakeLiveBridge.seeded();
    const id = sessionClipId(0, 0); // Drums "Beat"
    await bridge.deleteClip(id);
    const clips = bridge.listClips(trackId(0));
    // The slot 0 now reports empty rather than disappearing.
    expect(clips[0]?.kind).toBe('empty');
    expect(clips[0]?.slotId).toBe(clipSlotId(0, 0));
    // Re-reading the deleted clip id throws STALE_REFERENCE (the slot is empty).
    expect(
      isBridgeErrorOfCode(
        captured(() => bridge.getNotes(id)),
        'STALE_REFERENCE',
      ),
    ).toBe(true);
  });

  it('splices an arrangement clip out of the track', async () => {
    const bridge = FakeLiveBridge.seeded();
    const id = arrangementClipId(1, 0); // Bass (arr)
    await bridge.deleteClip(id);
    const arr = bridge.listClips(trackId(1)).filter((c) => c.location === 'arrangement');
    expect(arr.length).toBe(0);
  });

  it('commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.deleteClip(sessionClipId(0, 0));
    expect(bridge.transactionCount).toBe(1);
  });

  it('throws STALE_REFERENCE for a missing clip and WRONG_TYPE for a non-clip id', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.deleteClip(arrangementClipId(1, 9))).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'STALE_REFERENCE'),
    );
    await expect(bridge.deleteClip(trackId(0))).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'WRONG_TYPE'),
    );
  });

  it('deleting an already-empty session slot throws STALE_REFERENCE', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Drums slot 1 is empty.
    await expect(bridge.deleteClip(sessionClipId(0, 1))).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'STALE_REFERENCE'),
    );
  });
});

describe('createArrangementMidiClip: creates an arrangement MIDI clip in one undo', () => {
  it('appends an empty MIDI clip at the start beat and returns its ClipInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Bass (track 1) already has 1 arrangement clip at index 0.
    const clip = await bridge.createArrangementMidiClip(trackId(1), 16, 8);
    expect(clip.id).toBe(arrangementClipId(1, 1));
    expect(clip.kind).toBe('midi');
    expect(clip.location).toBe('arrangement');
    expect(clip.startTime).toBe(16);
    expect(clip.duration).toBe(8);
    expect(clip.endTime).toBe(24);
    expect(bridge.getNotes(clip.id)).toEqual([]);
  });

  it('commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.createArrangementMidiClip(trackId(0), 0, 4);
    expect(bridge.transactionCount).toBe(1);
  });

  it('rejects a non-MIDI track (WRONG_TYPE) and bad geometry (BAD_INPUT)', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Vocals (track 2) is audio.
    await expect(bridge.createArrangementMidiClip(trackId(2), 0, 4)).rejects.toSatisfy(
      (e: unknown) => isBridgeErrorOfCode(e, 'WRONG_TYPE'),
    );
    await expect(bridge.createArrangementMidiClip(trackId(0), 0, 0)).rejects.toSatisfy(
      (e: unknown) => isBridgeErrorOfCode(e, 'BAD_INPUT'),
    );
    await expect(bridge.createArrangementMidiClip(trackId(0), -1, 4)).rejects.toSatisfy(
      (e: unknown) => isBridgeErrorOfCode(e, 'BAD_INPUT'),
    );
  });

  it('the created clip is fillable via setNotes (the recreate-then-populate path)', async () => {
    const bridge = FakeLiveBridge.seeded();
    const clip = await bridge.createArrangementMidiClip(trackId(0), 0, 4);
    await bridge.setNotes(clip.id, [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }]);
    expect(bridge.getNotes(clip.id).length).toBe(1);
  });
});

describe('createArrangementAudioClip: creates an arrangement audio clip by file', () => {
  it('appends an audio clip carrying its filePath and returns its ClipInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Vocals (track 2) is audio with 1 arrangement clip at index 0.
    const clip = await bridge.createArrangementAudioClip(trackId(2), {
      filePath: '/audio/gtr.wav',
      startTime: 8,
      duration: 4,
    });
    expect(clip.id).toBe(arrangementClipId(2, 1));
    expect(clip.kind).toBe('audio');
    expect(clip.location).toBe('arrangement');
    expect(clip.filePath).toBe('/audio/gtr.wav');
    expect(clip.startTime).toBe(8);
    expect(clip.duration).toBe(4);
    // listClips surfaces the filePath for the audio clip.
    const listed = bridge.listClips(trackId(2)).find((c) => c.id === clip.id);
    expect(listed?.filePath).toBe('/audio/gtr.wav');
  });

  it('commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.createArrangementAudioClip(trackId(2), AUDIO_ARGS);
    expect(bridge.transactionCount).toBe(1);
  });

  it('rejects a non-audio track (WRONG_TYPE) and bad args (BAD_INPUT)', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Drums (track 0) is MIDI.
    await expect(bridge.createArrangementAudioClip(trackId(0), AUDIO_ARGS)).rejects.toSatisfy(
      (e: unknown) => isBridgeErrorOfCode(e, 'WRONG_TYPE'),
    );
    await expect(
      bridge.createArrangementAudioClip(trackId(2), { ...AUDIO_ARGS, filePath: '' }),
    ).rejects.toSatisfy((e: unknown) => isBridgeErrorOfCode(e, 'BAD_INPUT'));
    await expect(
      bridge.createArrangementAudioClip(trackId(2), { ...AUDIO_ARGS, duration: 0 }),
    ).rejects.toSatisfy((e: unknown) => isBridgeErrorOfCode(e, 'BAD_INPUT'));
  });
});

describe('clearClipsInRange: cleans the arrangement target range in one undo', () => {
  it('removes a clip fully inside the range', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Bass (arr) is [0, 8). Clear [0, 8) removes it.
    await bridge.clearClipsInRange(trackId(1), 0, 8);
    const arr = bridge.listClips(trackId(1)).filter((c) => c.location === 'arrangement');
    expect(arr.length).toBe(0);
  });

  it('truncates a clip that overlaps a boundary rather than deleting it', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Bass (arr) is [0, 8). Clearing [4, 8) truncates it to [0, 4).
    await bridge.clearClipsInRange(trackId(1), 4, 8);
    const arr = bridge.listClips(trackId(1)).filter((c) => c.location === 'arrangement');
    expect(arr.length).toBe(1);
    expect(arr[0]?.startTime).toBe(0);
    expect(arr[0]?.duration).toBe(4);
    expect(arr[0]?.endTime).toBe(4);
  });

  it('leaves a clip fully outside the range untouched', async () => {
    const bridge = FakeLiveBridge.seeded();
    // Bass (arr) is [0, 8). Clearing [16, 24) touches nothing.
    await bridge.clearClipsInRange(trackId(1), 16, 24);
    const arr = bridge.listClips(trackId(1)).filter((c) => c.location === 'arrangement');
    expect(arr.length).toBe(1);
    expect(arr[0]?.duration).toBe(8);
  });

  it('commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.clearClipsInRange(trackId(1), 0, 8);
    expect(bridge.transactionCount).toBe(1);
  });

  it('rejects a non-track id (WRONG_TYPE) and a bad range (BAD_INPUT)', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.clearClipsInRange(clipSlotId(0, 0), 0, 8)).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'WRONG_TYPE'),
    );
    await expect(bridge.clearClipsInRange(trackId(1), 8, 8)).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'BAD_INPUT'),
    );
    await expect(bridge.clearClipsInRange(trackId(1), 8, 4)).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'BAD_INPUT'),
    );
  });
});

describe('createCuePoint: creates an arrangement locator in one undo', () => {
  it('creates a cue point at the beat with the name and returns its CuePointInfo', async () => {
    const bridge = FakeLiveBridge.seeded();
    expect(bridge.getSongOverview().cuePointCount).toBe(0);
    const cp = await bridge.createCuePoint(16, 'Chorus');
    expect(cp.id).toBe(cuePointId(0));
    expect(cp.time).toBe(16);
    expect(cp.name).toBe('Chorus');
    expect(bridge.getSongOverview().cuePointCount).toBe(1);
  });

  it('keeps cue points ordered by beat', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.createCuePoint(32, 'Outro');
    const second = await bridge.createCuePoint(8, 'Intro');
    // "Intro" at beat 8 sorts before "Outro" at 32, so it takes index 0.
    expect(second.id).toBe(cuePointId(0));
    expect(bridge.getSongOverview().cuePointCount).toBe(2);
  });

  it('commits exactly one undo step', async () => {
    const bridge = FakeLiveBridge.seeded();
    await bridge.createCuePoint(4, 'A');
    expect(bridge.transactionCount).toBe(1);
  });

  it('rejects a negative or non-finite beat (BAD_INPUT)', async () => {
    const bridge = FakeLiveBridge.seeded();
    await expect(bridge.createCuePoint(-1, 'A')).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'BAD_INPUT'),
    );
    await expect(bridge.createCuePoint(Number.NaN, 'A')).rejects.toSatisfy((e: unknown) =>
      isBridgeErrorOfCode(e, 'BAD_INPUT'),
    );
    expect(bridge.transactionCount).toBe(0);
  });
});

describe('Wave B mutations batch into ONE undo step inside a transaction', () => {
  it('a Session-to-Song-style build (clear + creates + cue points) is one undo', async () => {
    const bridge = FakeLiveBridge.seededSession();
    expect(bridge.transactionCount).toBe(0);

    await bridge.transaction(() =>
      Promise.all([
        bridge.clearClipsInRange(trackId(0), 0, 64),
        bridge.createArrangementMidiClip(trackId(0), 0, 16),
        bridge.createArrangementMidiClip(trackId(0), 16, 16),
        bridge.createCuePoint(0, 'Intro'),
        bridge.createCuePoint(16, 'Verse'),
      ]),
    );

    // Five mutations, ONE user-facing undo step.
    expect(bridge.transactionCount).toBe(1);
    const arr = bridge.listClips(trackId(0)).filter((c) => c.location === 'arrangement');
    expect(arr.length).toBe(2);
    expect(bridge.getSongOverview().cuePointCount).toBe(2);
  });

  it('a Set-Janitor-style sweep (recolors + delete) is one undo', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    expect(bridge.transactionCount).toBe(0);

    await bridge.transaction(() =>
      Promise.all([
        bridge.setClipProps(sessionClipId(0, 0), { color: 16711680 }),
        bridge.setTrackProps(trackId(1), { name: 'Keys' }),
        bridge.deleteTrack(trackId(2)), // the Empty audio track
      ]),
    );

    expect(bridge.transactionCount).toBe(1);
    expect(bridge.listTracks().length).toBe(2);
    expect(bridge.listClips(trackId(0))[0]?.color).toBe(16711680);
    expect(bridge.listTracks()[1]?.name).toBe('Keys');
  });

  it('rolls the whole sweep back on any rejection and commits no undo step', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const beforeColor = bridge.listClips(trackId(0))[0]?.color;
    const beforeCount = bridge.listTracks().length;

    await expect(
      bridge.transaction(() =>
        Promise.all([
          bridge.setClipProps(sessionClipId(0, 0), { color: 999 }),
          // This delete targets a missing track -> the whole transaction rolls back.
          bridge.deleteTrack(trackId(99)),
        ]),
      ),
    ).rejects.toBeDefined();

    expect(bridge.listClips(trackId(0))[0]?.color).toBe(beforeColor);
    expect(bridge.listTracks().length).toBe(beforeCount);
    expect(bridge.transactionCount).toBe(0);
  });
});

describe('Wave B factory fixtures', () => {
  it('seededSession exposes scenes and per-scene session clips for the planner', () => {
    const bridge = FakeLiveBridge.seededSession();
    expect(bridge.listScenes().map((s) => s.name)).toEqual(['Intro', 'Verse', 'Chorus']);

    // Keys (track 0) has a clip in every scene; Drums (track 1) is empty in scene 0.
    const keysClips = bridge.listClips(trackId(0)).filter((c) => c.kind !== 'empty');
    expect(keysClips.length).toBe(3);
    const drumsScene0 = bridge.listClips(trackId(1))[0];
    expect(drumsScene0?.kind).toBe('empty');

    // The audio clips reference a file (Session-to-Song reads filePath to recreate).
    const drumsVerse = bridge.listClips(trackId(1))[1];
    expect(drumsVerse?.kind).toBe('audio');
    expect(drumsVerse?.filePath).toBe('/audio/verse_beat.wav');
  });

  it('seededMessySet plants an empty track, placeholder names, off-palette color, loop overrun', () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const tracks = bridge.listTracks();
    expect(tracks.map((t) => t.name)).toEqual(['Bass', '1-MIDI', 'Empty']);

    // Empty track: no clips, no devices.
    const empty = tracks[2];
    expect(empty?.deviceCount).toBe(0);
    expect(empty?.arrangementClipCount).toBe(0);
    expect(bridge.listClips(trackId(2)).every((c) => c.kind === 'empty')).toBe(true);

    // Off-palette color on Bass slot 0; a loop-overrun clip on Bass slot 1.
    const bassClips = bridge.listClips(trackId(0));
    expect(bassClips[0]?.color).toBe(12345);
    expect(bassClips[1]?.name).toBe('Loop');
    expect(bassClips[1]?.loopEnd).toBe(4);
    // listClips surfaces endMarker (stage-3 gap resolution): the "Loop" clip overruns
    // its loop (content ends at 6, loop ends at 4), which the loop-overrun rule reads.
    expect(bassClips[1]?.endMarker).toBe(6);

    // Placeholder clip name on the placeholder track.
    expect(bridge.listClips(trackId(1))[0]?.name).toBe('Audio 3');
  });

  it('listClips surfaces endMarker on clips and reports 0 for empty slots', () => {
    const bridge = FakeLiveBridge.seeded();
    // Drums "Beat" (session clip): a 4-beat loop whose content ends at 4 (no overrun).
    const beat = bridge.listClips(trackId(0))[0];
    expect(beat?.kind).toBe('midi');
    expect(beat?.endMarker).toBe(4);
    // Drums slot 1 is empty: endMarker is 0 (there is no content).
    const emptySlot = bridge.listClips(trackId(0))[1];
    expect(emptySlot?.kind).toBe('empty');
    expect(emptySlot?.endMarker).toBe(0);
  });

  it('seededAudioTrack isolates a single audio track with a known mixer volume', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    expect(bridge.listTracks().length).toBe(1);
    expect(bridge.listTracks()[0]?.kind).toBe('audio');
    expect((await bridge.getTrackMixer(trackId(0))).volume.value).toBe(0.6);
    expect(bridge.firstMixerVolumeId).toBe(mixerVolumeParamId(0));
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
