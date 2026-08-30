/**
 * Integration tests for the Session-to-Song handler,
 * pinned against {@link FakeLiveBridge} with no Ableton install.
 *
 * Seeds the Session fixture (scenes + clip slots + clips), runs `runSessionToSong`,
 * and asserts the fake's Arrangement now holds clips at the planned beats with the
 * planned names/colors, the cue points exist, and the build reports its exact
 * committed undo phases. The "recreate, not move"
 * path (read notes/filePath from the Session source, write to a fresh Arrangement
 * clip) is exercised end to end without any audio file.
 *
 * Creator results arrive asynchronously, so clears, creation, and dependent
 * population are independent SDK transaction phases. Real Live remains the final
 * gate for its user-facing undo history.
 */

import { describe, expect, it } from 'vitest';

import { FakeLiveBridge } from '../fake-live-bridge.js';
import { runSessionToSong, SessionToSongPartialBuildError } from '../handlers/session-to-song.js';
import { isPlayableClip, type ClipInfo, type Section, type TimeSig } from '../dtos.js';
import { isBridgeErrorOfCode, sdkRejected } from '../errors.js';
import type { TrackId } from '../ids.js';

const FOUR_FOUR: TimeSig = { num: 4, den: 4 };

/** Intro / Verse / Chorus, each 8 bars of 4/4 (32 beats), bound to current scene refs. */
function sectionMap(bridge: FakeLiveBridge): readonly Section[] {
  const scenes = bridge.listScenes();
  return [
    { name: 'Intro', sceneRef: scenes[0]!.id, bars: 8 },
    { name: 'Verse', sceneRef: scenes[1]!.id, bars: 8 },
    { name: 'Chorus', sceneRef: scenes[2]!.id, bars: 8 },
  ];
}

/** The arrangement clips on a track, in array order. */
function arrangementClips(bridge: FakeLiveBridge, track: number): readonly ClipInfo[] {
  return bridge
    .listClips(bridge.listTracks()[track]!.id)
    .filter((clip) => clip.location === 'arrangement' && isPlayableClip(clip));
}

describe('runSessionToSong: recreates the Session as an Arrangement', () => {
  it('reports the placement and cue-point counts', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const result = await runSessionToSong(bridge, {
      sectionMap: sectionMap(bridge),
      timeSig: FOUR_FOUR,
    });
    // 32-beat sections repeat the 4-beat Session loops physically: 24 Keys + 16 Drums.
    expect(result.placementCount).toBe(40);
    // One cue point per section.
    expect(result.cuePointCount).toBe(3);
    expect(result.undoStepCount).toBe(3);
  });

  it('places the MIDI track clips at the planned beats, named and colored', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });

    const keys = arrangementClips(bridge, 0);
    // Each 4-beat source loop becomes eight physical clips per 32-beat section.
    expect(keys.length).toBe(24);
    expect(keys.map((c) => c.startTime)).toEqual(
      Array.from({ length: 24 }, (_, index) => index * 4),
    );
    expect(keys.every((c) => c.duration === 4)).toBe(true);
    expect(keys.every((c) => c.kind === 'midi')).toBe(true);
    expect(keys.map((c) => c.name)).toEqual([
      ...Array<string>(8).fill('Intro Keys'),
      ...Array<string>(8).fill('Verse Keys'),
      ...Array<string>(8).fill('Chorus Keys'),
    ]);
    // Source clip color (8421504) carried onto every placement (no section override).
    expect(keys.every((c) => c.color === 8421504)).toBe(true);
  });

  it('copies each MIDI source clip notes onto its recreated Arrangement clip', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });

    const keys = arrangementClips(bridge, 0);
    // seededSession: Intro Keys = pitch 60, Verse Keys = 62, Chorus Keys = 64.
    const introNotes = bridge.getNotes(keys[0]!.id as never);
    const verseNotes = bridge.getNotes(keys[8]!.id as never);
    const chorusNotes = bridge.getNotes(keys[16]!.id as never);
    expect(introNotes.map((n) => n.pitch)).toEqual([60]);
    expect(verseNotes.map((n) => n.pitch)).toEqual([62]);
    expect(chorusNotes.map((n) => n.pitch)).toEqual([64]);
  });

  it('places the audio track clips by file at the planned beats (recreate, not move)', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });

    const drums = arrangementClips(bridge, 1);
    // Drums is empty in the Intro, so Verse and Chorus each create eight loops.
    expect(drums.length).toBe(16);
    expect(drums.map((c) => c.startTime)).toEqual(
      Array.from({ length: 16 }, (_, index) => 32 + index * 4),
    );
    expect(drums.every((c) => c.kind === 'audio')).toBe(true);
    expect(drums.map((c) => c.name)).toEqual([
      ...Array<string>(8).fill('Verse Beat'),
      ...Array<string>(8).fill('Chorus Beat'),
    ]);
    // The audio clip references the source file (filePath copied, not relocated).
    expect(drums.map((c) => c.filePath)).toEqual([
      ...Array<string>(8).fill('/audio/verse_beat.wav'),
      ...Array<string>(8).fill('/audio/chorus_beat.wav'),
    ]);
  });

  it('creates one named cue point per section boundary', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });
    expect(bridge.getSongOverview().cuePointCount).toBe(3);
  });

  it('records clear, creation, and dependent population as exactly three undo steps', async () => {
    const bridge = FakeLiveBridge.seededSession();
    expect(bridge.transactionCount).toBe(0);
    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });
    expect(bridge.transactionCount).toBe(3);
  });

  it('clears the touched tracks target range before writing (no stale leftovers)', async () => {
    // Pre-place a stray clip on the Keys arrangement; the build's clear should remove it.
    const bridge = FakeLiveBridge.seededSession();
    await bridge.createArrangementMidiClip(bridge.listTracks()[0]!.id, 0, 8);
    expect(arrangementClips(bridge, 0).length).toBe(1);
    expect(bridge.transactionCount).toBe(1); // the manual create above

    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });

    // The stray clip is gone; only the physical source-length loops remain.
    const keys = arrangementClips(bridge, 0);
    expect(keys.length).toBe(24);
    expect(keys.map((c) => c.startTime)).toEqual(
      Array.from({ length: 24 }, (_, index) => index * 4),
    );
    // The build itself adds its three honest undo steps after the manual create.
    expect(bridge.transactionCount).toBe(4);
  });

  it('a section color overrides the placed clip colors in that section', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const colored: readonly Section[] = [
      { name: 'Verse', sceneRef: bridge.listScenes()[1]!.id, bars: 8, color: 777 },
    ];
    await runSessionToSong(bridge, { sectionMap: colored, timeSig: FOUR_FOUR });
    // Verse maps Keys (track 0) + Drums (track 1); both placed clips take color 777.
    expect(arrangementClips(bridge, 0)[0]?.color).toBe(777);
    expect(arrangementClips(bridge, 1)[0]?.color).toBe(777);
  });

  it('an empty section map writes nothing and commits no transaction', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const result = await runSessionToSong(bridge, { sectionMap: [], timeSig: FOUR_FOUR });
    expect(result).toEqual({ placementCount: 0, cuePointCount: 0, undoStepCount: 0 });
    expect(arrangementClips(bridge, 0).length).toBe(0);
    expect(bridge.getSongOverview().cuePointCount).toBe(0);
    // An empty plan (no placements and no cue points) skips the transaction entirely,
    // so a no-op build leaves no undo step.
    expect(bridge.transactionCount).toBe(0);
  });

  it('uses only creation and naming undo steps for a cue-only plan with no clears', async () => {
    const bridge = FakeLiveBridge.seededSession();
    bridge.listClips = () => [];

    const result = await runSessionToSong(bridge, {
      sectionMap: [{ name: 'Silent', sceneRef: bridge.listScenes()[0]!.id, bars: 2 }],
      timeSig: FOUR_FOUR,
    });

    expect(result).toEqual({ placementCount: 0, cuePointCount: 1, undoStepCount: 2 });
    expect(bridge.transactionCount).toBe(2);
  });

  it('follows a selected scene reference after the scene order changes before apply', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const openingScenes = bridge.listScenes();
    const originalListClips = bridge.listClips.bind(bridge);
    const reorderedScenes = [openingScenes[1]!, openingScenes[2]!, openingScenes[0]!];

    // Model a delayed modal apply after Intro moved from index 0 to index 2. Session
    // clip metadata moves with the scene, as it does in the host, while the selected
    // opaque scene reference stays the same.
    bridge.listScenes = () => reorderedScenes;
    bridge.listClips = (trackId: TrackId): readonly ClipInfo[] =>
      originalListClips(trackId).map((entry) => {
        if (!isPlayableClip(entry) || entry.location !== 'session') return entry;
        const movedIndex = entry.sceneIndex === 0 ? 2 : entry.sceneIndex - 1;
        return { ...entry, sceneIndex: movedIndex };
      });

    await runSessionToSong(bridge, {
      sectionMap: [{ name: 'Moved Intro', sceneRef: openingScenes[0]!.id, bars: 8 }],
      timeSig: FOUR_FOUR,
    });

    const keys = arrangementClips(bridge, 0);
    expect(keys).toHaveLength(8);
    expect(keys[0]?.name).toBe('Intro Keys');
    expect(bridge.getNotes(keys[0]!.id as never).map((note) => note.pitch)).toEqual([60]);
  });

  it('fails closed before reads or writes when a selected scene was deleted while the dialog was open', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const openingScenes = bridge.listScenes();

    bridge.listScenes = () => openingScenes.filter((scene) => scene.id !== openingScenes[1]!.id);
    bridge.listClips = () => {
      throw new Error('Session clips must not be read after stale-scene preflight fails.');
    };

    await expect(
      runSessionToSong(bridge, {
        sectionMap: [{ name: 'Deleted Verse', sceneRef: openingScenes[1]!.id, bars: 8 }],
        timeSig: FOUR_FOUR,
      }),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'STALE_REFERENCE'));
    expect(bridge.transactionCount).toBe(0);
  });

  it('fails closed when a bridge omits required Session scene metadata', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const originalListClips = bridge.listClips.bind(bridge);
    bridge.listClips = (trackId: TrackId): readonly ClipInfo[] =>
      originalListClips(trackId).map((entry) => {
        if (!isPlayableClip(entry) || entry.location !== 'session') return entry;
        const { sceneIndex: _discardedSceneIndex, ...withoutSceneIndex } = entry;
        return withoutSceneIndex as unknown as ClipInfo;
      });

    await expect(
      runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR }),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects unsupported audio loop/source-offset geometry before either write phase', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const originalListClips = bridge.listClips.bind(bridge);
    bridge.listClips = (trackId: TrackId): readonly ClipInfo[] =>
      originalListClips(trackId).map((entry) =>
        isPlayableClip(entry) && entry.location === 'session' && !entry.isMidi
          ? { ...entry, loopStart: 1 }
          : entry,
      );

    await expect(
      runSessionToSong(bridge, {
        sectionMap: [{ name: 'Verse', sceneRef: bridge.listScenes()[1]!.id, bars: 2 }],
        timeSig: FOUR_FOUR,
      }),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'UNSUPPORTED'));
    expect(bridge.transactionCount).toBe(0);
  });

  it('waits for a delayed clear before initiating any Arrangement creator', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const originalClear = bridge.clearClipsInRange.bind(bridge);
    let releaseClear!: () => void;
    const clearReleased = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    let signalClearEntered!: () => void;
    const clearEntered = new Promise<void>((resolve) => {
      signalClearEntered = resolve;
    });
    bridge.clearClipsInRange = async (...args) => {
      signalClearEntered();
      await clearReleased;
      return originalClear(...args);
    };

    const pending = runSessionToSong(bridge, {
      sectionMap: [{ name: 'Intro', sceneRef: bridge.listScenes()[0]!.id, bars: 2 }],
      timeSig: FOUR_FOUR,
    });
    await clearEntered;
    expect(arrangementClips(bridge, 0)).toHaveLength(0);

    releaseClear();
    await pending;
    expect(arrangementClips(bridge, 0)).toHaveLength(2);
  });

  it('reports one exact restoration undo when creation fails after clearing', async () => {
    const bridge = FakeLiveBridge.seededSession();
    bridge.createArrangementMidiClip = async () => {
      throw sdkRejected('simulated creator failure');
    };

    await expect(
      runSessionToSong(bridge, {
        sectionMap: [{ name: 'Intro', sceneRef: bridge.listScenes()[0]!.id, bars: 2 }],
        timeSig: FOUR_FOUR,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SessionToSongPartialBuildError &&
        error.phase === 'create' &&
        error.undoStepsToRestore === 1 &&
        error.hint.includes('Undo once'),
    );
    expect(bridge.transactionCount).toBe(1);
    expect(arrangementClips(bridge, 0)).toHaveLength(0);
  });

  it('retains phase 1 and reports an actionable typed error when population fails', async () => {
    const bridge = FakeLiveBridge.seededSession();
    bridge.setClipProps = async () => {
      throw sdkRejected('simulated property failure');
    };

    await expect(
      runSessionToSong(bridge, {
        sectionMap: [{ name: 'Intro', sceneRef: bridge.listScenes()[0]!.id, bars: 2 }],
        timeSig: FOUR_FOUR,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SessionToSongPartialBuildError &&
        error.phase === 'populate' &&
        error.undoStepsToRestore === 2 &&
        error.hint.includes('Undo twice'),
    );
    // Clear + creation committed; population rolled itself back and did not add an undo.
    expect(bridge.transactionCount).toBe(2);
    expect(arrangementClips(bridge, 0)).toHaveLength(2);
  });

  it('reports one restoration undo when population fails after a cue-only creation phase', async () => {
    const bridge = FakeLiveBridge.seededSession();
    bridge.listClips = () => [];
    bridge.setCuePointName = async () => {
      throw sdkRejected('simulated cue naming failure');
    };

    await expect(
      runSessionToSong(bridge, {
        sectionMap: [{ name: 'Silent', sceneRef: bridge.listScenes()[0]!.id, bars: 2 }],
        timeSig: FOUR_FOUR,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SessionToSongPartialBuildError &&
        error.phase === 'populate' &&
        error.undoStepsToRestore === 1 &&
        error.hint.includes('Undo once'),
    );
    expect(bridge.transactionCount).toBe(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid bar count %s before writes',
    async (bars) => {
      const bridge = FakeLiveBridge.seededSession();
      await expect(
        runSessionToSong(bridge, {
          sectionMap: [{ name: 'Invalid', sceneRef: bridge.listScenes()[0]!.id, bars }],
          timeSig: FOUR_FOUR,
        }),
      ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
      expect(bridge.transactionCount).toBe(0);
    },
  );

  it.each([
    { num: 0, den: 4 },
    { num: -1, den: 4 },
    { num: Number.NaN, den: 4 },
    { num: Number.POSITIVE_INFINITY, den: 4 },
    { num: 4, den: 0 },
    { num: 4, den: -1 },
    { num: 4, den: Number.NaN },
    { num: 4, den: Number.NEGATIVE_INFINITY },
  ])('rejects invalid fallback time signature %# before writes', async (timeSig) => {
    const bridge = FakeLiveBridge.seededSession();
    await expect(
      runSessionToSong(bridge, {
        sectionMap: [{ name: 'Invalid', sceneRef: bridge.listScenes()[0]!.id, bars: 2 }],
        timeSig,
      }),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects an invalid current scene time signature before writes', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const originalListScenes = bridge.listScenes.bind(bridge);
    bridge.listScenes = () =>
      originalListScenes().map((scene) => ({ ...scene, signatureDenominator: 0 }));

    await expect(
      runSessionToSong(bridge, {
        sectionMap: [{ name: 'Invalid', sceneRef: originalListScenes()[0]!.id, bars: 2 }],
        timeSig: FOUR_FOUR,
      }),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    expect(bridge.transactionCount).toBe(0);
  });
});
