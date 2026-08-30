/**
 * Integration tests for the Session-to-Song handler,
 * pinned against {@link FakeLiveBridge} with no Ableton install.
 *
 * Seeds the Session fixture (scenes + clip slots + clips), runs `runSessionToSong`,
 * and asserts the fake's Arrangement now holds clips at the planned beats with the
 * planned names/colors, the cue points exist, and the WHOLE build was recorded as
 * exactly ONE transaction (one undo). The "recreate, not move"
 * path (read notes/filePath from the Session source, write to a fresh Arrangement
 * clip) is exercised end to end without any audio file.
 *
 * The create-then-populate one-undo grouping --
 * `createArrangementMidiClip` (async) then the sync `setNotes`/`setClipProps`, all
 * inside one `withinTransaction` -- needs in-Live confirmation on the build machine
 * needs confirmation in the actual host. The fake proves the handler issues one
 * transaction; only real Live proves the host collapses an async-create-then-set
 * batch into a single user-facing undo.
 */

import { describe, expect, it } from 'vitest';

import { FakeLiveBridge } from '../fake-live-bridge.js';
import { runSessionToSong } from '../handlers/session-to-song.js';
import { isPlayableClip, type ClipInfo, type Section, type TimeSig } from '../dtos.js';
import { isBridgeErrorOfCode } from '../errors.js';
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
    // Keys in all 3 sections (3) + Drums in Verse + Chorus (2) = 5 placements.
    expect(result.placementCount).toBe(5);
    // One cue point per section.
    expect(result.cuePointCount).toBe(3);
  });

  it('places the MIDI track clips at the planned beats, named and colored', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });

    const keys = arrangementClips(bridge, 0);
    // Three Keys placements: Intro @0, Verse @32, Chorus @64, each 32 beats long.
    expect(keys.length).toBe(3);
    expect(keys.map((c) => c.startTime)).toEqual([0, 32, 64]);
    expect(keys.every((c) => c.duration === 32)).toBe(true);
    expect(keys.every((c) => c.kind === 'midi')).toBe(true);
    expect(keys.map((c) => c.name)).toEqual(['Intro Keys', 'Verse Keys', 'Chorus Keys']);
    // Source clip color (8421504) carried onto every placement (no section override).
    expect(keys.every((c) => c.color === 8421504)).toBe(true);
  });

  it('copies each MIDI source clip notes onto its recreated Arrangement clip', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });

    const keys = arrangementClips(bridge, 0);
    // seededSession: Intro Keys = pitch 60, Verse Keys = 62, Chorus Keys = 64.
    const introNotes = bridge.getNotes(keys[0]!.id as never);
    const verseNotes = bridge.getNotes(keys[1]!.id as never);
    const chorusNotes = bridge.getNotes(keys[2]!.id as never);
    expect(introNotes.map((n) => n.pitch)).toEqual([60]);
    expect(verseNotes.map((n) => n.pitch)).toEqual([62]);
    expect(chorusNotes.map((n) => n.pitch)).toEqual([64]);
  });

  it('places the audio track clips by file at the planned beats (recreate, not move)', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });

    const drums = arrangementClips(bridge, 1);
    // Drums is empty in the Intro, so only Verse @32 + Chorus @64.
    expect(drums.length).toBe(2);
    expect(drums.map((c) => c.startTime)).toEqual([32, 64]);
    expect(drums.every((c) => c.kind === 'audio')).toBe(true);
    expect(drums.map((c) => c.name)).toEqual(['Verse Beat', 'Chorus Beat']);
    // The audio clip references the source file (filePath copied, not relocated).
    expect(drums.map((c) => c.filePath)).toEqual([
      '/audio/verse_beat.wav',
      '/audio/chorus_beat.wav',
    ]);
  });

  it('creates one named cue point per section boundary', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });
    expect(bridge.getSongOverview().cuePointCount).toBe(3);
  });

  it('records the WHOLE build as exactly ONE transaction (one undo)', async () => {
    const bridge = FakeLiveBridge.seededSession();
    expect(bridge.transactionCount).toBe(0);
    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });
    // Five placements (each a create + setNotes/setClipProps), two cue points, and a
    // clear per touched track -- all collapse into ONE user-facing undo step.
    expect(bridge.transactionCount).toBe(1);
  });

  it('clears the touched tracks target range before writing (no stale leftovers)', async () => {
    // Pre-place a stray clip on the Keys arrangement; the build's clear should remove it.
    const bridge = FakeLiveBridge.seededSession();
    await bridge.createArrangementMidiClip(bridge.listTracks()[0]!.id, 0, 8);
    expect(arrangementClips(bridge, 0).length).toBe(1);
    expect(bridge.transactionCount).toBe(1); // the manual create above

    await runSessionToSong(bridge, { sectionMap: sectionMap(bridge), timeSig: FOUR_FOUR });

    // The stray clip is gone; only the 3 planned Keys placements remain.
    const keys = arrangementClips(bridge, 0);
    expect(keys.length).toBe(3);
    expect(keys.map((c) => c.startTime)).toEqual([0, 32, 64]);
    // The build itself is the second undo step (the manual create was the first).
    expect(bridge.transactionCount).toBe(2);
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
    expect(result).toEqual({ placementCount: 0, cuePointCount: 0 });
    expect(arrangementClips(bridge, 0).length).toBe(0);
    expect(bridge.getSongOverview().cuePointCount).toBe(0);
    // An empty plan (no placements and no cue points) skips the transaction entirely,
    // so a no-op build leaves no undo step.
    expect(bridge.transactionCount).toBe(0);
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
    expect(keys).toHaveLength(1);
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
});
