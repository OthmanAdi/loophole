/**
 * Ring 1 unit tests for the pure {@link snapToScale} transform (Scale Lock, W1). No
 * bridge, no I/O, exact-output assertions. 03_EXTENSIONS_SPEC §1(f).
 *
 * Covers the spec's required cases: C-major exact tables, an in-scale note left
 * unchanged, a note between two scale tones under each of up/down/nearest, the 0/127
 * MIDI boundary clamp, an empty scale (no-op), and movedCount correctness. Plus one
 * strengthening case (a scale with a 3-semitone gap) that pins `'nearest'` as DISTINCT
 * from `'up'`: in C major every off-scale pitch is equidistant from both neighbours,
 * so a tie-breaks-up `'nearest'` is indistinguishable from `'up'` there.
 */

import { describe, expect, it } from 'vitest';

import type { NoteDTO, Scale } from '../dtos.js';
import { snapToScale } from '../transforms/scale.js';

/** C major: root C (0), intervals the major scale. Off-scale pcs are 1,3,6,8,10. */
const C_MAJOR: Scale = { root: 0, intervals: [0, 2, 4, 5, 7, 9, 11] };

/** A one-note "scale" (just the root C): every non-C pitch class is off-scale. */
const ROOT_ONLY: Scale = { root: 0, intervals: [0] };

/** A scale with a 3-semitone gap between its two tones (C and D#), to expose nearest. */
const GAPPED: Scale = { root: 0, intervals: [0, 3] };

/** Build a minimal note at `pitch` (beat 0, one beat long). */
function note(pitch: number): NoteDTO {
  return { pitch, startTime: 0, duration: 1 };
}

describe('snapToScale: C major exact tables', () => {
  // Each off-scale pitch class is exactly one semitone from both neighbours, so
  // up/down move by +1/-1 and nearest (tie -> up) matches up.
  const cases: ReadonlyArray<{
    readonly from: number;
    readonly up: number;
    readonly down: number;
    readonly nearest: number;
  }> = [
    { from: 61, up: 62, down: 60, nearest: 62 }, // C#4 between C4 and D4
    { from: 63, up: 64, down: 62, nearest: 64 }, // D#4 between D4 and E4
    { from: 66, up: 67, down: 65, nearest: 67 }, // F#4 between F4 and G4
    { from: 68, up: 69, down: 67, nearest: 69 }, // G#4 between G4 and A4
    { from: 70, up: 71, down: 69, nearest: 71 }, // A#4 between A4 and B4
  ];

  for (const c of cases) {
    it(`pitch ${c.from}: up=${c.up}, down=${c.down}, nearest=${c.nearest}`, () => {
      expect(snapToScale([note(c.from)], C_MAJOR, 'up').notes[0]?.pitch).toBe(c.up);
      expect(snapToScale([note(c.from)], C_MAJOR, 'down').notes[0]?.pitch).toBe(c.down);
      expect(snapToScale([note(c.from)], C_MAJOR, 'nearest').notes[0]?.pitch).toBe(c.nearest);
    });
  }
});

describe('snapToScale: an in-scale note is left unchanged', () => {
  it('keeps every C-major scale tone exactly where it is, in all three modes', () => {
    // E4 (64) is in C major.
    for (const mode of ['up', 'down', 'nearest'] as const) {
      const result = snapToScale([note(64)], C_MAJOR, mode);
      expect(result.notes[0]?.pitch).toBe(64);
      expect(result.movedCount).toBe(0);
    }
  });

  it('preserves the note count and the other fields of an unchanged note', () => {
    const input: NoteDTO = { pitch: 60, startTime: 2, duration: 0.5, velocity: 100, muted: true };
    const result = snapToScale([input], C_MAJOR, 'nearest');
    expect(result.notes.length).toBe(1);
    expect(result.notes[0]).toEqual(input);
  });
});

describe('snapToScale: a note between two scale tones', () => {
  it('moves up, down, or to the nearest tone as the mode dictates (F#4)', () => {
    // F#4 (66) sits between F4 (65) and G4 (67).
    expect(snapToScale([note(66)], C_MAJOR, 'up').notes[0]?.pitch).toBe(67);
    expect(snapToScale([note(66)], C_MAJOR, 'down').notes[0]?.pitch).toBe(65);
    expect(snapToScale([note(66)], C_MAJOR, 'nearest').notes[0]?.pitch).toBe(67); // tie -> up
  });

  it("'nearest' picks the strictly closer tone (not the tie-break) over a 3-semitone gap", () => {
    // Scale {C, D#}. Pitch C#4 (61) is 1 below D# (63) -> wait: relative to root C.
    // pc(61)=1: down to C (pc 0) is -1, up to D# (pc 3) is +2. nearest -> down.
    expect(snapToScale([note(61)], GAPPED, 'nearest').notes[0]?.pitch).toBe(60);
    // And it is genuinely different from 'up' here (which jumps +2 to D#4 = 63).
    expect(snapToScale([note(61)], GAPPED, 'up').notes[0]?.pitch).toBe(63);
    expect(snapToScale([note(61)], GAPPED, 'down').notes[0]?.pitch).toBe(60);

    // pc(62)=2: down to C is -2, up to D# is +1. nearest -> up (the strictly closer one).
    expect(snapToScale([note(62)], GAPPED, 'nearest').notes[0]?.pitch).toBe(63);
    expect(snapToScale([note(62)], GAPPED, 'down').notes[0]?.pitch).toBe(60);
  });
});

describe('snapToScale: MIDI boundary clamp at pitch 0 and 127', () => {
  it('leaves pitch 0 and 127 untouched when they are already in scale (C major)', () => {
    // 0 is C (in scale); 127 % 12 = 7 = G (in scale). Both stay put.
    expect(snapToScale([note(0)], C_MAJOR, 'nearest').notes[0]?.pitch).toBe(0);
    expect(snapToScale([note(127)], C_MAJOR, 'nearest').notes[0]?.pitch).toBe(127);
    expect(snapToScale([note(0), note(127)], C_MAJOR, 'nearest').movedCount).toBe(0);
  });

  it('clamps an up-snap that would exceed 127 back to 127 (counts as not moved)', () => {
    // Scale {C only}. Pitch 127 (pc 7) snapping 'up' seeks the next C: +5 -> 132,
    // which clamps to 127. The note does not actually move, so movedCount is 0.
    const result = snapToScale([note(127)], ROOT_ONLY, 'up');
    expect(result.notes[0]?.pitch).toBe(127);
    expect(result.movedCount).toBe(0);
  });

  it('clamps a down-snap that would fall below 0 back to 0 (counts as not moved)', () => {
    // Scale {C only}. Pitch 0 is C, already in scale -> unchanged. Use pitch 1 (pc 1)
    // snapping 'down' to C: -1 -> 0 (in range, moves). Then pitch 5 (pc 5) 'down' to C
    // is -5 -> 0. To force a clamp-below-zero, snap pitch 1 'down' which lands exactly
    // on 0 (no clamp needed). Instead, a non-root low pitch under a high-only scale:
    const highOnly: Scale = { root: 0, intervals: [11] }; // only B (pc 11)
    // Pitch 0 (pc 0) 'down' to B seeks -1 -> pc 11 at pitch -1, clamps to 0. Not moved.
    const result = snapToScale([note(0)], highOnly, 'down');
    expect(result.notes[0]?.pitch).toBe(0);
    expect(result.movedCount).toBe(0);
  });
});

describe('snapToScale: empty scale is a no-op', () => {
  it('returns a fresh structural copy unchanged with movedCount 0', () => {
    const input: readonly NoteDTO[] = [note(61), note(63), note(66)];
    const empty: Scale = { root: 0, intervals: [] };
    const result = snapToScale(input, empty, 'nearest');
    expect(result.movedCount).toBe(0);
    expect(result.notes).toEqual(input);
    // Fresh array and fresh objects (the read-map-assign contract), not the same refs.
    expect(result.notes).not.toBe(input);
    expect(result.notes[0]).not.toBe(input[0]);
  });
});

describe('snapToScale: movedCount correctness', () => {
  it('counts only the notes that actually changed pitch', () => {
    // 60 (C, in scale), 61 (C#, moves), 64 (E, in scale), 66 (F#, moves).
    const input = [note(60), note(61), note(64), note(66)];
    const result = snapToScale(input, C_MAJOR, 'nearest');
    expect(result.movedCount).toBe(2);
    expect(result.notes.map((n) => n.pitch)).toEqual([60, 62, 64, 67]);
  });

  it('is 0 when every note is already in scale', () => {
    const input = [note(60), note(62), note(64), note(65), note(67)];
    expect(snapToScale(input, C_MAJOR, 'up').movedCount).toBe(0);
  });

  it('is the full count when every note is off scale', () => {
    const input = [note(61), note(63), note(66), note(68), note(70)];
    expect(snapToScale(input, C_MAJOR, 'down').movedCount).toBe(5);
  });
});

describe('snapToScale: purity (never mutates its input)', () => {
  it('leaves the input array and its notes untouched (assign-back contract)', () => {
    const input: readonly NoteDTO[] = [note(61), note(60)];
    snapToScale(input, C_MAJOR, 'up');
    expect(input[0]?.pitch).toBe(61);
    expect(input[1]?.pitch).toBe(60);
    expect(input.length).toBe(2);
  });

  it('respects a non-C root (D major) when projecting pitch classes', () => {
    // D major: root D (2), intervals major scale -> in-scale pcs include F# (6) and
    // C# (1), but NOT F (5) or C (0). So F4 (65, pc 5) is off-scale and snaps.
    const dMajor: Scale = { root: 2, intervals: [0, 2, 4, 5, 7, 9, 11] };
    // pc 5 (F): up to F# (pc 6) is +1 -> 66; down to E (pc 4) is -1 -> 64.
    expect(snapToScale([note(65)], dMajor, 'up').notes[0]?.pitch).toBe(66);
    expect(snapToScale([note(65)], dMajor, 'down').notes[0]?.pitch).toBe(64);
    // D itself (62, pc 2) is the root and in scale -> unchanged.
    expect(snapToScale([note(62)], dMajor, 'nearest').notes[0]?.pitch).toBe(62);
  });
});
