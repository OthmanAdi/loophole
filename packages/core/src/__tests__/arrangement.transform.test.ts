/**
 * Ring 1 unit tests for the pure arrangement planner (Session-to-Song, W5).
 * No bridge, no I/O: hand-built {@link SessionDTO}s in, exact {@link PlanResult} out.
 *
 * The bulk of Session-to-Song's correctness lives here (03_EXTENSIONS_SPEC §4(f)):
 * bars-to-beats accumulation, mixed-meter maths, one placement per
 * (section × track-with-a-clip-in-that-scene), cue-point beats on the section
 * boundaries with the right names, and an empty scene yielding no placements.
 */

import { describe, expect, it } from 'vitest';

import { beatsPerBar, planArrangement } from '../transforms/arrangement.js';
import { sessionClipId } from '../ids.js';
import type { Section, SessionClipDTO, SessionDTO, TimeSig } from '../dtos.js';

const FOUR_FOUR: TimeSig = { num: 4, den: 4 };

/**
 * A two-track Session (Keys = track 0, Drums = track 1) with three scenes
 * (Intro / Verse / Chorus). Keys has a clip in every scene; Drums is empty in the
 * Intro (scene 0) and has a clip in Verse + Chorus, mirroring the
 * {@link import('../fake-live-bridge.js').FakeLiveBridge.seededSession} layout so the
 * pure and handler tests describe the same Session.
 */
function buildSession(): SessionDTO {
  const clip = (
    track: number,
    scene: number,
    name: string,
    color: number,
    isMidi: boolean,
  ): SessionClipDTO => ({
    clipRef: sessionClipId(track, scene),
    trackIndex: track,
    sceneIndex: scene,
    isMidi,
    name,
    color,
    durationBeats: 4,
    ...(isMidi
      ? { notes: [{ pitch: 60 + scene, startTime: 0, duration: 1, velocity: 100 }] }
      : { filePath: `/audio/track${String(track)}_scene${String(scene)}.wav` }),
  });

  return {
    tracks: [
      { id: sessionClipId(0, 0), name: 'Keys', type: 'midi' },
      { id: sessionClipId(1, 0), name: 'Drums', type: 'audio' },
    ],
    scenes: [
      { index: 0, name: 'Intro' },
      { index: 1, name: 'Verse' },
      { index: 2, name: 'Chorus' },
    ],
    clips: [
      clip(0, 0, 'Intro Keys', 8421504, true),
      clip(0, 1, 'Verse Keys', 8421504, true),
      clip(0, 2, 'Chorus Keys', 8421504, true),
      // Drums: no clip in scene 0 (Intro) -> no Drums placement there.
      clip(1, 1, 'Verse Beat', 255, false),
      clip(1, 2, 'Chorus Beat', 255, false),
    ],
  };
}

describe('beatsPerBar', () => {
  it('converts common signatures with one-quarter-note-per-beat', () => {
    expect(beatsPerBar({ num: 4, den: 4 })).toBe(4);
    expect(beatsPerBar({ num: 3, den: 4 })).toBe(3);
    expect(beatsPerBar({ num: 6, den: 8 })).toBe(3);
    expect(beatsPerBar({ num: 7, den: 8 })).toBe(3.5);
  });
});

describe('planArrangement: bars-to-beats accumulation', () => {
  it('8 bars of 4/4 spans 32 beats (section start beats accumulate)', () => {
    const session = buildSession();
    const sectionMap: readonly Section[] = [
      { name: 'A', sceneIndex: 0, bars: 8 },
      { name: 'B', sceneIndex: 1, bars: 8 },
    ];
    const { cuePoints } = planArrangement(session, sectionMap, FOUR_FOUR);
    // Section A starts at beat 0; section B starts after 8 bars * 4 beats = 32 beats.
    expect(cuePoints.map((c) => c.beat)).toEqual([0, 32]);
  });

  it('accumulates across three sections of differing bar lengths', () => {
    const session = buildSession();
    const sectionMap: readonly Section[] = [
      { name: 'Intro', sceneIndex: 0, bars: 4 }, // 16 beats -> next at 16
      { name: 'Verse', sceneIndex: 1, bars: 8 }, // 32 beats -> next at 48
      { name: 'Chorus', sceneIndex: 2, bars: 8 }, // 32 beats
    ];
    const { cuePoints } = planArrangement(session, sectionMap, FOUR_FOUR);
    expect(cuePoints.map((c) => c.beat)).toEqual([0, 16, 48]);
  });
});

describe('planArrangement: mixed-meter maths (a 3/4 section)', () => {
  it('a 3/4 section spans 3 beats per bar and shifts everything after it', () => {
    // Scene 1 reports a 3/4 signature; scenes 0 and 2 stay at the 4/4 plan default.
    // Mixing meters is what makes this probative: a broken accumulation would not
    // survive a 3/4 section sitting between two 4/4 sections.
    const session: SessionDTO = {
      ...buildSession(),
      scenes: [
        { index: 0, name: 'Intro' }, // 4/4 (no override) -> plan default
        { index: 1, name: 'Verse', timeSig: { num: 3, den: 4 } }, // 3/4 override
        { index: 2, name: 'Chorus' }, // 4/4
      ],
    };
    const sectionMap: readonly Section[] = [
      { name: 'Intro', sceneIndex: 0, bars: 4 }, // 4 * 4 = 16 beats -> next at 16
      { name: 'Verse', sceneIndex: 1, bars: 4 }, // 4 * 3 = 12 beats -> next at 28
      { name: 'Chorus', sceneIndex: 2, bars: 4 }, // 4 * 4 = 16 beats
    ];
    const { cuePoints, placements } = planArrangement(session, sectionMap, FOUR_FOUR);

    expect(cuePoints.map((c) => c.beat)).toEqual([0, 16, 28]);
    // The Verse (3/4) placements span 12 beats, not 16.
    const verseKeys = placements.find((p) => p.name === 'Verse Keys');
    expect(verseKeys?.startBeat).toBe(16);
    expect(verseKeys?.durationBeats).toBe(12);
    // The Chorus that follows starts at 28 (16 + 12), proving the 3/4 shift carried.
    const chorusKeys = placements.find((p) => p.name === 'Chorus Keys');
    expect(chorusKeys?.startBeat).toBe(28);
    expect(chorusKeys?.durationBeats).toBe(16);
  });
});

describe('planArrangement: one placement per (section x track-with-a-clip-in-that-scene)', () => {
  it('emits a placement only for tracks that have a clip in the mapped scene', () => {
    const session = buildSession();
    const sectionMap: readonly Section[] = [
      { name: 'Intro', sceneIndex: 0, bars: 4 }, // only Keys has a scene-0 clip
      { name: 'Verse', sceneIndex: 1, bars: 4 }, // Keys + Drums
      { name: 'Chorus', sceneIndex: 2, bars: 4 }, // Keys + Drums
    ];
    const { placements } = planArrangement(session, sectionMap, FOUR_FOUR);

    // 1 (Intro: Keys) + 2 (Verse: Keys, Drums) + 2 (Chorus: Keys, Drums) = 5.
    expect(placements.length).toBe(5);

    // Intro has exactly one placement, on Keys (track 0).
    const intro = placements.filter((p) => p.startBeat === 0);
    expect(intro.length).toBe(1);
    expect(intro[0]?.trackIndex).toBe(0);
    expect(intro[0]?.name).toBe('Intro Keys');

    // Verse (start beat 16) has both tracks.
    const verse = placements.filter((p) => p.startBeat === 16);
    expect(verse.map((p) => p.trackIndex).sort()).toEqual([0, 1]);
  });

  it('carries the source clip ref, name, and color onto each placement', () => {
    const session = buildSession();
    const sectionMap: readonly Section[] = [{ name: 'Verse', sceneIndex: 1, bars: 4 }];
    const { placements } = planArrangement(session, sectionMap, FOUR_FOUR);

    const keys = placements.find((p) => p.trackIndex === 0);
    expect(keys?.sourceClipRef).toBe(sessionClipId(0, 1));
    expect(keys?.name).toBe('Verse Keys');
    expect(keys?.color).toBe(8421504); // source clip color (no section override)
    expect(keys?.durationBeats).toBe(16); // 4 bars * 4 beats

    const drums = placements.find((p) => p.trackIndex === 1);
    expect(drums?.sourceClipRef).toBe(sessionClipId(1, 1));
    expect(drums?.color).toBe(255);
  });

  it('a section color overrides every clip color in that section', () => {
    const session = buildSession();
    const sectionMap: readonly Section[] = [{ name: 'Verse', sceneIndex: 1, bars: 4, color: 99 }];
    const { placements } = planArrangement(session, sectionMap, FOUR_FOUR);
    expect(placements.length).toBe(2);
    expect(placements.every((p) => p.color === 99)).toBe(true);
  });
});

describe('planArrangement: cue points', () => {
  it('emits one cue point per section, at its start boundary, named after the section', () => {
    const session = buildSession();
    const sectionMap: readonly Section[] = [
      { name: 'Intro', sceneIndex: 0, bars: 8 },
      { name: 'Verse', sceneIndex: 1, bars: 16 },
      { name: 'Chorus', sceneIndex: 2, bars: 16 },
    ];
    const { cuePoints } = planArrangement(session, sectionMap, FOUR_FOUR);
    expect(cuePoints).toEqual([
      { beat: 0, name: 'Intro' },
      { beat: 32, name: 'Verse' }, // after 8 bars * 4
      { beat: 96, name: 'Chorus' }, // after 32 + 16 bars * 4
    ]);
  });

  it('emits a cue point for every section, including an empty one', () => {
    const session = buildSession();
    const sectionMap: readonly Section[] = [
      { name: 'Silence', sceneIndex: 99, bars: 4 }, // scene 99 has no clips
      { name: 'Verse', sceneIndex: 1, bars: 4 },
    ];
    const { cuePoints, placements } = planArrangement(session, sectionMap, FOUR_FOUR);
    // Cue points: one per section regardless of whether the section had any clip.
    expect(cuePoints.map((c) => c.name)).toEqual(['Silence', 'Verse']);
    expect(cuePoints.map((c) => c.beat)).toEqual([0, 16]);
    // Placements: none for the empty section; only the Verse's two.
    expect(placements.every((p) => p.startBeat === 16)).toBe(true);
    expect(placements.length).toBe(2);
  });
});

describe('planArrangement: empty scene yields no placements', () => {
  it('a section mapped to a scene with no clips emits no placements but still advances + cues', () => {
    const session = buildSession();
    const sectionMap: readonly Section[] = [{ name: 'Empty', sceneIndex: 99, bars: 8 }];
    const { placements, cuePoints } = planArrangement(session, sectionMap, FOUR_FOUR);
    expect(placements).toEqual([]);
    expect(cuePoints).toEqual([{ beat: 0, name: 'Empty' }]);
  });

  it('an empty section map yields no placements and no cue points', () => {
    const session = buildSession();
    const { placements, cuePoints } = planArrangement(session, [], FOUR_FOUR);
    expect(placements).toEqual([]);
    expect(cuePoints).toEqual([]);
  });

  it('is pure: planning does not mutate the session or the section map', () => {
    const session = buildSession();
    const sectionMap: readonly Section[] = [{ name: 'Verse', sceneIndex: 1, bars: 4 }];
    const clipsBefore = session.clips.length;
    planArrangement(session, sectionMap, FOUR_FOUR);
    expect(session.clips.length).toBe(clipsBefore);
    expect(sectionMap.length).toBe(1);
  });
});
