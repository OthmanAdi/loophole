/**
 * Pure scale-snapping transform over {@link NoteDTO}[] (Scale Lock, W1).
 *
 * Like {@link import("./notes.js")}'s transforms, this has no I/O and touches neither
 * the bridge nor the SDK. It is the cheapest, fastest test ring (ring 1) and it
 * encodes the SDK's read-map-assign contract: it returns a fresh array of fresh note
 * objects and never mutates its input, exactly how `MidiClip.notes` must be rewritten.
 *
 * The algorithm projects each note's pitch into pitch-class space (0..11, relative to
 * the scale root), and if that pitch class is not in the scale, moves the pitch to the
 * nearest in-scale pitch class in the requested {@link SnapMode} direction. See
 * {@link snapToScale} for the exact rules (tie-breaking, clamping, the empty-scale
 * no-op). Grounded in 03_EXTENSIONS_SPEC §1(b)/§1(f).
 */

import type { NoteDTO, Scale, SnapMode } from '../dtos.js';
import { clampPitch, mapClipNotes } from './notes.js';

/** The number of pitch classes in an octave; pitch-class space is 0..11. */
const SEMITONES_PER_OCTAVE = 12;

/** The result of {@link snapToScale}: the snapped notes and how many actually moved. */
export interface SnapResult {
  /** A fresh array of notes with each off-scale pitch snapped into the scale. */
  readonly notes: NoteDTO[];
  /** How many notes ended on a different pitch than they started (post-clamp). */
  readonly movedCount: number;
}

/**
 * Reduce a value to a pitch class 0..11. Works for negative inputs (e.g. a pitch
 * below the root): `((-1 % 12) + 12) % 12 === 11`.
 */
function toPitchClass(value: number): number {
  return ((value % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;
}

/**
 * Build the set of in-scale pitch classes (0..11) from a {@link Scale}: each interval
 * is offset from the root and reduced into pitch-class space. Duplicates collapse
 * (a `Set`), and membership is tested with `Set.has` so no array is ever indexed
 * (satisfies `noUncheckedIndexedAccess`).
 */
function inScalePitchClasses(scale: Scale): ReadonlySet<number> {
  const pcs = new Set<number>();
  for (const interval of scale.intervals) {
    pcs.add(toPitchClass(scale.root + interval));
  }
  return pcs;
}

/**
 * The signed semitone delta to move `pitch` onto an in-scale pitch class, in the
 * requested {@link SnapMode} direction. Returns 0 when the pitch is already in scale.
 *
 * Searches outward one semitone at a time (at most 11 steps, since every pitch class
 * has an in-scale neighbour within an octave when the scale is non-empty):
 *  - `'up'`   takes the first in-scale pitch class at a positive offset,
 *  - `'down'` takes the first at a negative offset,
 *  - `'nearest'` takes whichever is closer and, on a tie (equidistant up and down,
 *    e.g. a pitch one semitone from both neighbours), rounds UP. The tie-break is a
 *    fixed choice (both directions are musically valid); it is asserted in the tests
 *    so it cannot drift.
 */
function snapDelta(pitch: number, inScale: ReadonlySet<number>, mode: SnapMode): number {
  if (inScale.has(toPitchClass(pitch))) {
    return 0;
  }
  if (mode === 'up') {
    for (let step = 1; step < SEMITONES_PER_OCTAVE; step += 1) {
      if (inScale.has(toPitchClass(pitch + step))) {
        return step;
      }
    }
    return 0;
  }
  if (mode === 'down') {
    for (let step = 1; step < SEMITONES_PER_OCTAVE; step += 1) {
      if (inScale.has(toPitchClass(pitch - step))) {
        return -step;
      }
    }
    return 0;
  }
  // 'nearest': expand symmetrically, preferring up on a tie.
  for (let step = 1; step < SEMITONES_PER_OCTAVE; step += 1) {
    if (inScale.has(toPitchClass(pitch + step))) {
      return step;
    }
    if (inScale.has(toPitchClass(pitch - step))) {
      return -step;
    }
  }
  return 0;
}

/**
 * Snap every note's pitch to the scale, moving off-scale pitches in the requested
 * direction and reporting how many moved. Pure: returns a fresh array of fresh notes
 * and never mutates its input (the read-map-assign contract).
 *
 * Per note:
 *  1. project the pitch into a pitch class 0..11 relative to `scale.root`,
 *  2. if that pitch class is in the scale, keep the note unchanged,
 *  3. otherwise compute the in-scale {@link snapDelta} for `mode`, add it to the
 *     absolute pitch, and {@link clampPitch} the result to 0..127 (matching Live
 *     rejecting out-of-range pitches; clamping respects directional intent, never
 *     jumping an octave the other way to chase a pitch class past the boundary), and
 *  4. count the note as moved only if its FINAL (post-clamp) pitch differs from the
 *     original. In the rare case where a snap target lands outside 0..127 and clamps
 *     back to the original pitch, the note is honestly counted as not moved.
 *
 * Degenerate input is a no-op: an empty `scale.intervals` (the Set has nothing to
 * snap to) returns a fresh structural copy with `movedCount: 0`, the same way
 * {@link import("./notes.js").humanizeTiming} returns a copy on a zero amount rather
 * than throwing. The pure core never raises a `BridgeError`; that is the bridge's
 * model. 03_EXTENSIONS_SPEC §1(b)/§1(f).
 */
export function snapToScale(notes: readonly NoteDTO[], scale: Scale, mode: SnapMode): SnapResult {
  const inScale = inScalePitchClasses(scale);
  // Empty scale: nothing to snap to, so copy through unchanged (no-op).
  if (inScale.size === 0) {
    return { notes: mapClipNotes(notes, (note) => ({ ...note })), movedCount: 0 };
  }
  let movedCount = 0;
  const snapped = mapClipNotes(notes, (note) => {
    const delta = snapDelta(note.pitch, inScale, mode);
    if (delta === 0) {
      return { ...note };
    }
    const finalPitch = clampPitch(note.pitch + delta);
    if (finalPitch !== note.pitch) {
      movedCount += 1;
    }
    return { ...note, pitch: finalPitch };
  });
  return { notes: snapped, movedCount };
}
