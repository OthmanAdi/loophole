/**
 * Ring 1 unit tests for the pure groove transform (Humanize / Groove Sculptor, W2).
 * No bridge, no I/O. Determinism comes from an injected fixed-seed rng, so every
 * assertion is an exact-output check (03_EXTENSIONS_SPEC §2(f)).
 *
 * The rng here is a simple cyclic sequence: each call returns the next value in the
 * list, wrapping around. Because `humanize` draws in a fixed, documented order
 * (per note, gated axes only, timing -> velocity -> duration -> living), the resulting
 * note arrays are exactly reproducible and hand-checkable.
 */

import { describe, expect, it } from 'vitest';

import type { GridInfo, HumanizeOpts, NoteDTO } from '../dtos.js';
import { gridInfoFrom, humanize } from '../transforms/groove.js';

/** A deterministic rng: returns `values` in order, cycling. */
function seqRng(values: readonly number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    // values is non-empty in every caller; guard noUncheckedIndexedAccess.
    return v ?? 0;
  };
}

/** The headline grid for these tests: a 1/16 straight cell is 0.25 beats wide. */
const GRID_16: GridInfo = { quantization: '1/16', isTriplet: false, beatsPerCell: 0.25 };

describe('gridInfoFrom: derives beatsPerCell from the raw overview fields', () => {
  it('maps the documented straight + triplet labels (GridInfo table)', () => {
    expect(gridInfoFrom('1/4', false).beatsPerCell).toBe(1);
    expect(gridInfoFrom('1/8', false).beatsPerCell).toBe(0.5);
    expect(gridInfoFrom('1/16', false).beatsPerCell).toBe(0.25);
    expect(gridInfoFrom('1/32', false).beatsPerCell).toBe(0.125);
    expect(gridInfoFrom('1/8', true).beatsPerCell).toBeCloseTo(1 / 3, 10);
    expect(gridInfoFrom('1/16', true).beatsPerCell).toBeCloseTo(1 / 6, 10);
  });

  it('carries the raw label + triplet flag through unchanged', () => {
    const grid = gridInfoFrom('1/16', true);
    expect(grid.quantization).toBe('1/16');
    expect(grid.isTriplet).toBe(true);
  });

  it('falls back to a one-beat cell for an unrecognised label (e.g. "None")', () => {
    expect(gridInfoFrom('None', false).beatsPerCell).toBe(1);
    expect(gridInfoFrom('', true).beatsPerCell).toBe(1);
    expect(gridInfoFrom('weird', false).beatsPerCell).toBe(1);
  });
});

describe('humanize: exact output for a fixed seed', () => {
  it('nudges timing and velocity by the documented scaled amounts', () => {
    const notes: readonly NoteDTO[] = [
      { pitch: 36, startTime: 0, duration: 0.25, velocity: 100 },
      { pitch: 38, startTime: 1, duration: 0.25, velocity: 90 },
    ];
    const opts: HumanizeOpts = {
      strength: 0.5,
      doTiming: true,
      doVelocity: true,
      doDuration: false,
    };
    // Per note the draw order is timing then velocity:
    //  note 0: timing 0.0 -> factor -1 -> 0 + (-1)*(0.25*0.5)= -0.125 -> clamped to 0;
    //          velocity 1.0 -> factor +1 -> 100 + 1*0.5*64 = 132 -> clamped to 127.
    //  note 1: timing 0.25 -> factor -0.5 -> 1 + (-0.5)*0.125 = 0.9375;
    //          velocity 0.75 -> factor +0.5 -> 90 + 0.5*0.5*64 = 106.
    const out = humanize(notes, opts, GRID_16, seqRng([0.0, 1.0, 0.25, 0.75]));
    expect(out).toEqual([
      { pitch: 36, startTime: 0, duration: 0.25, velocity: 127 },
      { pitch: 38, startTime: 0.9375, duration: 0.25, velocity: 106 },
    ]);
  });

  it('never mutates its input (read-map-assign contract)', () => {
    const notes: readonly NoteDTO[] = [{ pitch: 60, startTime: 1, duration: 1, velocity: 64 }];
    humanize(
      notes,
      { strength: 1, doTiming: true, doVelocity: true, doDuration: true },
      GRID_16,
      seqRng([0.3, 0.7, 0.1]),
    );
    expect(notes[0]).toEqual({ pitch: 60, startTime: 1, duration: 1, velocity: 64 });
  });

  it('returns a fresh array of fresh notes', () => {
    const notes: readonly NoteDTO[] = [{ pitch: 60, startTime: 0, duration: 1, velocity: 64 }];
    const out = humanize(
      notes,
      { strength: 0.4, doTiming: true, doVelocity: false, doDuration: false },
      GRID_16,
      seqRng([0.5]),
    );
    expect(out).not.toBe(notes);
    expect(out[0]).not.toBe(notes[0]);
  });
});

describe('humanize: strength 0 is an identity transform', () => {
  it('returns a structural copy unchanged regardless of gates/swing/living', () => {
    const notes: readonly NoteDTO[] = [
      { pitch: 60, startTime: 1.5, duration: 1, velocity: 80, probability: 0.9 },
      { pitch: 64, startTime: 2.5, duration: 0.5, velocity: 100 },
    ];
    const opts: HumanizeOpts = {
      strength: 0,
      doTiming: true,
      doVelocity: true,
      doDuration: true,
      swing: 0.75,
      living: true,
    };
    const out = humanize(notes, opts, GRID_16, seqRng([0.1, 0.2, 0.3, 0.4]));
    // Value-equal to the input, but a fresh array of fresh objects.
    expect(out).toEqual(notes);
    expect(out).not.toBe(notes);
    expect(out[0]).not.toBe(notes[0]);
  });
});

describe('humanize: velocity always lands in 1..127', () => {
  it('clamps to the floor of 1 and the ceiling of 127 across rng extremes', () => {
    // Notes that start at the velocity extremes; full strength pushes well past both
    // ends, so the clamp is what keeps every result in range.
    const notes: readonly NoteDTO[] = Array.from({ length: 8 }, (_v, i) => ({
      pitch: 60,
      startTime: i * 0.25,
      duration: 0.25,
      velocity: i % 2 === 0 ? 127 : 1,
    }));
    const opts: HumanizeOpts = { strength: 1, doTiming: true, doVelocity: true, doDuration: true };
    for (const seed of [0, 0.5, 0.999]) {
      const out = humanize(notes, opts, GRID_16, seqRng([seed]));
      for (const note of out) {
        expect(note.velocity).toBeGreaterThanOrEqual(1);
        expect(note.velocity).toBeLessThanOrEqual(127);
      }
    }
  });

  it('centres a note that carries no velocity on a sane default rather than NaN', () => {
    const notes: readonly NoteDTO[] = [{ pitch: 60, startTime: 0, duration: 1 }];
    // velocity draw 0.5 -> factor 0 -> base (default 100) unchanged.
    const out = humanize(
      notes,
      { strength: 1, doTiming: false, doVelocity: true, doDuration: false },
      GRID_16,
      seqRng([0.5]),
    );
    expect(out[0]?.velocity).toBe(100);
  });
});

describe('humanize: a 1/16 grid bounds the max timing offset', () => {
  it('keeps every nudged start within +/- one grid cell at full strength', () => {
    const notes: readonly NoteDTO[] = [{ pitch: 60, startTime: 2, duration: 1, velocity: 64 }];
    const opts: HumanizeOpts = {
      strength: 1,
      doTiming: true,
      doVelocity: false,
      doDuration: false,
    };
    // Max cell = beatsPerCell * strength = 0.25. rng=1 -> +0.25; rng=0 -> -0.25.
    const hi = humanize(notes, opts, GRID_16, seqRng([1]));
    const lo = humanize(notes, opts, GRID_16, seqRng([0]));
    expect(hi[0]?.startTime).toBeCloseTo(2.25, 10);
    expect(lo[0]?.startTime).toBeCloseTo(1.75, 10);
    // And a sweep stays strictly within the bound.
    for (const seed of [0, 0.25, 0.5, 0.75, 0.999]) {
      const out = humanize(notes, opts, GRID_16, seqRng([seed]));
      expect(Math.abs((out[0]?.startTime ?? 0) - 2)).toBeLessThanOrEqual(0.25);
    }
  });

  it('clamps a nudged start at beat 0 so no note starts before the clip', () => {
    const notes: readonly NoteDTO[] = [{ pitch: 60, startTime: 0.1, duration: 1, velocity: 64 }];
    // rng=0 -> factor -1 -> 0.1 - 0.25 = -0.15 -> clamped to 0.
    const out = humanize(
      notes,
      { strength: 1, doTiming: true, doVelocity: false, doDuration: false },
      GRID_16,
      seqRng([0]),
    );
    expect(out[0]?.startTime).toBe(0);
  });
});

describe('humanize: doTiming:false leaves startTime untouched', () => {
  it('does not move startTime while still varying velocity', () => {
    const notes: readonly NoteDTO[] = [{ pitch: 60, startTime: 1.5, duration: 1, velocity: 80 }];
    const opts: HumanizeOpts = {
      strength: 0.8,
      doTiming: false,
      doVelocity: true,
      doDuration: false,
    };
    // With timing off, the first draw (0.5 -> factor 0) feeds velocity: 80 unchanged.
    const out = humanize(notes, opts, GRID_16, seqRng([0.5, 0.9]));
    expect(out[0]?.startTime).toBe(1.5);
    expect(out[0]?.velocity).toBe(80);
  });
});

describe('humanize: optional duration jitter and swing', () => {
  it('scales duration by up to +/- 50% at full strength', () => {
    const notes: readonly NoteDTO[] = [{ pitch: 62, startTime: 0, duration: 2, velocity: 100 }];
    // dur draw 1 -> factor +1 -> 2 * (1 + 1*0.5) = 3.
    const out = humanize(
      notes,
      { strength: 1, doTiming: false, doVelocity: false, doDuration: true },
      GRID_16,
      seqRng([1]),
    );
    expect(out[0]?.duration).toBeCloseTo(3, 10);
  });

  it('never collapses a duration to zero or below', () => {
    const notes: readonly NoteDTO[] = [{ pitch: 62, startTime: 0, duration: 1, velocity: 100 }];
    // dur draw 0 -> factor -1 -> 1 * (1 - 0.5) = 0.5 (still > 0).
    const out = humanize(
      notes,
      { strength: 1, doTiming: false, doVelocity: false, doDuration: true },
      GRID_16,
      seqRng([0]),
    );
    expect(out[0]?.duration).toBeGreaterThan(0);
  });

  it('delays an off-beat note by the swing amount (deterministic, no draw)', () => {
    // 1/8 grid: cell = 0.5 beats. A note at 0.5 sits on the off-beat (cell index 1).
    const grid8: GridInfo = { quantization: '1/8', isTriplet: false, beatsPerCell: 0.5 };
    const notes: readonly NoteDTO[] = [{ pitch: 62, startTime: 0.5, duration: 1, velocity: 100 }];
    const opts: HumanizeOpts = {
      strength: 1,
      swing: 1,
      doTiming: false,
      doVelocity: false,
      doDuration: false,
    };
    // swing delay = swing * beatsPerCell * 0.5 = 1 * 0.5 * 0.5 = 0.25 -> 0.5 + 0.25 = 0.75.
    const out = humanize(notes, opts, grid8, seqRng([0]));
    expect(out[0]?.startTime).toBeCloseTo(0.75, 10);
  });

  it('leaves an on-beat note unswung', () => {
    // A note at beat 1 on the 1/8 grid sits on the beat (cell index 2, even).
    const grid8: GridInfo = { quantization: '1/8', isTriplet: false, beatsPerCell: 0.5 };
    const notes: readonly NoteDTO[] = [{ pitch: 62, startTime: 1, duration: 1, velocity: 100 }];
    const out = humanize(
      notes,
      { strength: 1, swing: 1, doTiming: false, doVelocity: false, doDuration: false },
      grid8,
      seqRng([0]),
    );
    expect(out[0]?.startTime).toBe(1);
  });
});

describe('humanize: living pattern writes probability / velocityDeviation', () => {
  it('writes both fields, scaled and deterministic, only when living is set', () => {
    const notes: readonly NoteDTO[] = [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }];
    const opts: HumanizeOpts = {
      strength: 1,
      doTiming: false,
      doVelocity: false,
      doDuration: false,
      living: true,
    };
    // Only living draws here: prob 0.5 -> 1 - 0.5*1*0.3 = 0.85; dev 0.25 -> 0.25*1*16 = 4.
    const out = humanize(notes, opts, GRID_16, seqRng([0.5, 0.25]));
    expect(out[0]?.probability).toBeCloseTo(0.85, 10);
    expect(out[0]?.velocityDeviation).toBeCloseTo(4, 10);
  });

  it('does not touch probability / velocityDeviation when living is unset', () => {
    const notes: readonly NoteDTO[] = [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }];
    const out = humanize(
      notes,
      { strength: 1, doTiming: true, doVelocity: false, doDuration: false },
      GRID_16,
      seqRng([0.5]),
    );
    expect(out[0]?.probability).toBeUndefined();
    expect(out[0]?.velocityDeviation).toBeUndefined();
  });
});
