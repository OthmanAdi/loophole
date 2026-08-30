/**
 * Pure music transforms over {@link NoteDTO}[].
 *
 * These functions have no I/O and touch neither the bridge nor the SDK, so unit tests
 * can exercise them without an Ableton install. They encode the SDK's read-map-assign
 * contract: each returns a new array of new note objects and never mutates its input,
 * exactly how `MidiClip.notes` must be rewritten.
 */

import type { NoteDTO } from '../dtos.js';
import { badInput } from '../errors.js';

/** MIDI pitch bounds; Live rejects writes outside this range. */
export const MIN_PITCH = 0;
export const MAX_PITCH = 127;

/** MIDI velocity bounds; Live rejects writes outside this range. */
export const MIN_VELOCITY = 0;
export const MAX_VELOCITY = 127;

/**
 * Reject a note whose numeric fields cannot be represented safely by the Live note
 * API. Finite out-of-range pitch and velocity values remain valid here because the
 * documented write policy is to clamp them; only non-finite values and invalid note
 * geometry are rejected.
 */
export function assertValidNote(note: NoteDTO): void {
  assertFinite(note.pitch, 'Note pitch');
  assertFiniteAtLeast(note.startTime, 0, 'Note startTime');
  assertFiniteGreaterThan(note.duration, 0, 'Note duration');
  if (note.velocity !== undefined) assertFinite(note.velocity, 'Note velocity');
  if (note.releaseVelocity !== undefined)
    assertFinite(note.releaseVelocity, 'Note releaseVelocity');
  if (note.probability !== undefined) {
    if (!Number.isFinite(note.probability) || note.probability < 0 || note.probability > 1) {
      throw badInput(
        `Note probability ${String(note.probability)} must be finite and within 0..1.`,
      );
    }
  }
  // Live's supported velocity-deviation surface is signed, so only reject values
  // that cannot be represented safely; do not impose a new musical range here.
  if (note.velocityDeviation !== undefined) {
    assertFinite(note.velocityDeviation, 'Note velocityDeviation');
  }
}

/** Reject every invalid note before a write or transform can partially process it. */
export function assertValidNotes(notes: readonly NoteDTO[]): void {
  for (const note of notes) {
    assertValidNote(note);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw badInput(`${label} ${String(value)} must be finite.`);
  }
}

function assertFiniteAtLeast(value: number, minimum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw badInput(`${label} ${String(value)} must be a finite number >= ${String(minimum)}.`);
  }
}

function assertFiniteGreaterThan(value: number, minimum: number, label: string): void {
  if (!Number.isFinite(value) || !(value > minimum)) {
    throw badInput(`${label} ${String(value)} must be a finite number > ${String(minimum)}.`);
  }
}

/** Clamp a pitch to the valid MIDI range 0..127. */
export function clampPitch(pitch: number): number {
  assertFinite(pitch, 'MIDI pitch');
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
 * Clamp a velocity to the valid MIDI range 0..127.
 *
 * Velocity is, unlike pitch, not necessarily integral in the SDK surface
 * (`NoteDescription.velocity` is a bare `number`), so this clamps the range without
 * rounding. Used on the write path so an out-of-range velocity is rejected the way
 * Live would reject it.
 */
export function clampVelocity(velocity: number): number {
  assertFinite(velocity, 'MIDI velocity');
  if (velocity < MIN_VELOCITY) {
    return MIN_VELOCITY;
  }
  if (velocity > MAX_VELOCITY) {
    return MAX_VELOCITY;
  }
  return velocity;
}

/**
 * Map every note through `fn`, returning a fresh array. The single read-map-write
 * primitive the other transforms (and the extension actions) build on: it makes the
 * "read the snapshot, map in JS, assign the whole array back" contract one call.
 *
 * Pure: `fn` should return a new note rather than mutating its argument, but even if
 * a caller's `fn` returned the same object, the returned array is always a fresh
 * array so the original is never aliased. The input array is never mutated.
 */
export function mapClipNotes(
  notes: readonly NoteDTO[],
  fn: (note: NoteDTO, index: number) => NoteDTO,
): NoteDTO[] {
  return notes.map((note, index) => fn(note, index));
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
  assertValidNotes(notes);
  assertFinite(semitones, 'Transpose semitones');
  const shift = Math.trunc(semitones);
  return mapClipNotes(notes, (note) => ({
    ...note,
    pitch: clampPitch(note.pitch + shift),
  }));
}

/**
 * Humanize note timing by nudging each note's `startTime` by up to `amountBeats`.
 *
 * Deterministic and pure. With no `rng` it returns a structural copy unchanged (so
 * the read-map-assign contract is exercised without nondeterminism in tests). With
 * an injected `rng` in [0, 1) it offsets each start time within +/- `amountBeats`,
 * clamped at 0 so no note starts before the clip. The Humanize transform adds the
 * richer groove model for velocity, probability, and swing.
 */
export function humanizeTiming(
  notes: readonly NoteDTO[],
  amountBeats: number,
  rng?: () => number,
): NoteDTO[] {
  assertValidNotes(notes);
  assertFiniteAtLeast(amountBeats, 0, 'Humanize amountBeats');
  if (rng === undefined || amountBeats <= 0) {
    return mapClipNotes(notes, (note) => ({ ...note }));
  }
  return mapClipNotes(notes, (note) => {
    const draw = rng();
    if (!Number.isFinite(draw) || draw < 0 || draw > 1) {
      throw badInput(`Humanize RNG draw ${String(draw)} must be finite and within 0..1.`);
    }
    const jitter = (draw * 2 - 1) * amountBeats;
    const startTime = Math.max(0, note.startTime + jitter);
    return { ...note, startTime };
  });
}
