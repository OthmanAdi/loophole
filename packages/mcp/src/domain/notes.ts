/**
 * Pure music transforms over {@link NoteDTO}[].
 *
 * These functions have no I/O and touch neither the bridge nor the SDK. They are
 * the cheapest, fastest test ring (ring 1) and they encode the SDK's read-map-assign
 * contract: each returns a new array of new note objects and never mutates its
 * input, exactly how `MidiClip.notes` must be rewritten.
 */

import type { NoteDTO } from '../bridge/dtos.js';

/** MIDI pitch bounds; Live rejects writes outside this range. */
export const MIN_PITCH = 0;
export const MAX_PITCH = 127;

/** Clamp a pitch to the valid MIDI range 0..127. */
export function clampPitch(pitch: number): number {
  if (pitch < MIN_PITCH) {
    return MIN_PITCH;
  }
  if (pitch > MAX_PITCH) {
    return MAX_PITCH;
  }
  // Pitches are integers; round defensively so a fractional input cannot slip
  // through to a host that expects a whole semitone.
  return Math.round(pitch);
}

/**
 * Transpose every note by `semitones`, clamping the result to 0..127.
 *
 * Pure: returns a fresh array of fresh notes; the input is never mutated. Notes
 * that would land outside the MIDI range are clamped to the boundary (matching
 * Live rejecting out-of-range pitches) rather than dropped, so note count is
 * preserved.
 */
export function transposeNotes(notes: readonly NoteDTO[], semitones: number): NoteDTO[] {
  const shift = Math.trunc(semitones);
  return notes.map((note) => ({
    ...note,
    pitch: clampPitch(note.pitch + shift),
  }));
}

/**
 * Humanize note timing by nudging each note's `startTime` by up to `amountBeats`.
 *
 * W0 stub: deterministic and pure. With no `rng` it returns a structural copy
 * unchanged (so the read-map-assign contract is exercised without nondeterminism
 * in tests). With an injected `rng` in [0, 1) it offsets each start time within
 * +/- `amountBeats`, clamped at 0 so no note starts before the clip. The richer
 * groove model (velocity, probability, swing) lands in wave W2 (Humanize).
 */
export function humanizeTiming(
  notes: readonly NoteDTO[],
  amountBeats: number,
  rng?: () => number,
): NoteDTO[] {
  if (rng === undefined || amountBeats <= 0) {
    return notes.map((note) => ({ ...note }));
  }
  return notes.map((note) => {
    const jitter = (rng() * 2 - 1) * amountBeats;
    const startTime = Math.max(0, note.startTime + jitter);
    return { ...note, startTime };
  });
}
