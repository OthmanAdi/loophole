/**
 * Ring 2 integration tests for the Session-to-Song handler (W5, the flagship),
 * pinned against {@link FakeLiveBridge} with no Ableton install.
 *
 * Seeds the Session fixture (scenes + clip slots + clips), runs `runSessionToSong`,
 * and asserts the fake's Arrangement now holds clips at the planned beats with the
 * planned names/colors, the cue points exist, and the WHOLE build was recorded as
 * exactly ONE transaction (one undo) -- the headline correctness claim
 * (03_EXTENSIONS_SPEC §4(f), ARCHITECTURE_DECISIONS §8). The "recreate, not move"
 * path (read notes/filePath from the Session source, write to a fresh Arrangement
 * clip) is exercised end to end without any audio file.
 *
 * Ring 3 (flagged, NOT covered here): the create-then-populate one-undo grouping --
 * `createArrangementMidiClip` (async) then the sync `setNotes`/`setClipProps`, all
 * inside one `withinTransaction` -- needs in-Live confirmation on the build machine
 * (03_EXTENSIONS_SPEC §4(b) "Build de-risk"). The fake proves the handler issues one
 * transaction; only real Live proves the host collapses an async-create-then-set
 * batch into a single user-facing undo. This is the W5 de-risk to run in
 * `E2E_CHECKLIST.md`.
 */

import { describe, expect, it } from 'vitest';

import { FakeLiveBridge } from '../fake-live-bridge.js';
import { runSessionToSong } from '../handlers/session-to-song.js';
import { trackId } from '../ids.js';
import type { ClipInfo, Section, TimeSig } from '../dtos.js';

const FOUR_FOUR: TimeSig = { num: 4, den: 4 };

/** Intro(scene0) / Verse(scene1) / Chorus(scene2), each 8 bars of 4/4 (32 beats). */
const SECTION_MAP: readonly Section[] = [
  { name: 'Intro', sceneIndex: 0, bars: 8 },
  { name: 'Verse', sceneIndex: 1, bars: 8 },
  { name: 'Chorus', sceneIndex: 2, bars: 8 },
];

/** The arrangement clips on a track, in array order. */
function arrangementClips(bridge: FakeLiveBridge, track: number): readonly ClipInfo[] {
  return bridge.listClips(trackId(track)).filter((c) => c.location === 'arrangement');
}

describe('runSessionToSong: recreates the Session as an Arrangement', () => {
  it('reports the placement and cue-point counts', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const result = await runSessionToSong(bridge, { sectionMap: SECTION_MAP, timeSig: FOUR_FOUR });
    // Keys in all 3 sections (3) + Drums in Verse + Chorus (2) = 5 placements.
    expect(result.placementCount).toBe(5);
    // One cue point per section.
    expect(result.cuePointCount).toBe(3);
  });

  it('places the MIDI track clips at the planned beats, named and colored', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await runSessionToSong(bridge, { sectionMap: SECTION_MAP, timeSig: FOUR_FOUR });

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
    await runSessionToSong(bridge, { sectionMap: SECTION_MAP, timeSig: FOUR_FOUR });

    const keys = arrangementClips(bridge, 0);
    // seededSession: Intro Keys = pitch 60, Verse Keys = 62, Chorus Keys = 64.
    const introNotes = bridge.getNotes(keys[0]!.id);
    const verseNotes = bridge.getNotes(keys[1]!.id);
    const chorusNotes = bridge.getNotes(keys[2]!.id);
    expect(introNotes.map((n) => n.pitch)).toEqual([60]);
    expect(verseNotes.map((n) => n.pitch)).toEqual([62]);
    expect(chorusNotes.map((n) => n.pitch)).toEqual([64]);
  });

  it('places the audio track clips by file at the planned beats (recreate, not move)', async () => {
    const bridge = FakeLiveBridge.seededSession();
    await runSessionToSong(bridge, { sectionMap: SECTION_MAP, timeSig: FOUR_FOUR });

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
    await runSessionToSong(bridge, { sectionMap: SECTION_MAP, timeSig: FOUR_FOUR });
    expect(bridge.getSongOverview().cuePointCount).toBe(3);
  });

  it('records the WHOLE build as exactly ONE transaction (one undo)', async () => {
    const bridge = FakeLiveBridge.seededSession();
    expect(bridge.transactionCount).toBe(0);
    await runSessionToSong(bridge, { sectionMap: SECTION_MAP, timeSig: FOUR_FOUR });
    // Five placements (each a create + setNotes/setClipProps), two cue points, and a
    // clear per touched track -- all collapse into ONE user-facing undo step.
    expect(bridge.transactionCount).toBe(1);
  });

  it('clears the touched tracks target range before writing (no stale leftovers)', async () => {
    // Pre-place a stray clip on the Keys arrangement; the build's clear should remove it.
    const bridge = FakeLiveBridge.seededSession();
    await bridge.createArrangementMidiClip(trackId(0), 0, 8);
    expect(arrangementClips(bridge, 0).length).toBe(1);
    expect(bridge.transactionCount).toBe(1); // the manual create above

    await runSessionToSong(bridge, { sectionMap: SECTION_MAP, timeSig: FOUR_FOUR });

    // The stray clip is gone; only the 3 planned Keys placements remain.
    const keys = arrangementClips(bridge, 0);
    expect(keys.length).toBe(3);
    expect(keys.map((c) => c.startTime)).toEqual([0, 32, 64]);
    // The build itself is the second undo step (the manual create was the first).
    expect(bridge.transactionCount).toBe(2);
  });

  it('a section color overrides the placed clip colors in that section', async () => {
    const bridge = FakeLiveBridge.seededSession();
    const colored: readonly Section[] = [{ name: 'Verse', sceneIndex: 1, bars: 8, color: 777 }];
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
});
