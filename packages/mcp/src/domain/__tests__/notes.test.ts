/**
 * Ring 1 unit tests for the pure note transforms. No bridge, no I/O.
 */

import { describe, expect, it } from 'vitest';

import type { NoteDTO } from '../../bridge/dtos.js';
import { clampPitch, humanizeTiming, MAX_PITCH, MIN_PITCH, transposeNotes } from '../notes.js';

describe('clampPitch', () => {
  it('clamps below 0 and above 127', () => {
    expect(clampPitch(-10)).toBe(MIN_PITCH);
    expect(clampPitch(999)).toBe(MAX_PITCH);
  });

  it('rounds fractional pitches to whole semitones', () => {
    expect(clampPitch(60.4)).toBe(60);
    expect(clampPitch(60.6)).toBe(61);
  });

  it('passes valid pitches through', () => {
    expect(clampPitch(64)).toBe(64);
  });
});

describe('transposeNotes', () => {
  const input: readonly NoteDTO[] = [
    { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
    { pitch: 120, startTime: 1, duration: 1 },
  ];

  it('shifts pitches by the given semitones', () => {
    const out = transposeNotes(input, 7);
    expect(out[0]?.pitch).toBe(67);
  });

  it('clamps at the MIDI ceiling (Live rejects > 127)', () => {
    const out = transposeNotes(input, 12);
    expect(out[1]?.pitch).toBe(127);
  });

  it('clamps at the MIDI floor on a downward shift', () => {
    const out = transposeNotes([{ pitch: 2, startTime: 0, duration: 1 }], -12);
    expect(out[0]?.pitch).toBe(0);
  });

  it('is a pure map and never mutates its input (assign-back contract)', () => {
    transposeNotes(input, 5);
    expect(input[0]?.pitch).toBe(60);
    expect(input[1]?.pitch).toBe(120);
  });

  it('preserves note count and the other fields', () => {
    const out = transposeNotes(input, 3);
    expect(out.length).toBe(2);
    expect(out[0]?.velocity).toBe(100);
    expect(out[0]?.startTime).toBe(0);
  });
});

describe('humanizeTiming', () => {
  const input: readonly NoteDTO[] = [
    { pitch: 60, startTime: 1, duration: 1 },
    { pitch: 62, startTime: 2, duration: 1 },
  ];

  it('returns an unchanged structural copy with no rng (deterministic stub)', () => {
    const out = humanizeTiming(input, 0.1);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(input[0]);
  });

  it('nudges start times within +/- amount when an rng is injected', () => {
    // rng = 1 -> max positive offset of +amount.
    const out = humanizeTiming(input, 0.25, () => 1);
    expect(out[0]?.startTime).toBeCloseTo(1.25);
    expect(out[1]?.startTime).toBeCloseTo(2.25);
  });

  it('never moves a note before beat 0', () => {
    // rng = 0 -> max negative offset of -amount; first note would go negative.
    const out = humanizeTiming([{ pitch: 60, startTime: 0.1, duration: 1 }], 0.5, () => 0);
    expect(out[0]?.startTime).toBe(0);
  });

  it('does not mutate its input', () => {
    humanizeTiming(input, 0.25, () => 1);
    expect(input[0]?.startTime).toBe(1);
  });
});
