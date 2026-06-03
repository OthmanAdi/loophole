/**
 * Pure groove transform for Humanize / Groove Sculptor (W2), 03_EXTENSIONS_SPEC §2.
 *
 * `humanize` takes stiff, perfectly-quantised MIDI and breathes life into it: it
 * nudges each note's `startTime`, `velocity`, and optionally `duration` by small
 * controlled random amounts, with an optional swing on off-beat positions. Like every
 * transform in this package it has no I/O and touches neither the bridge nor the SDK,
 * so it is the cheapest test ring (ring 1) and asserts exact output.
 *
 * Determinism is the whole point of the injected `rng`. The richer groove model wants
 * randomness, but a test must be able to assert an exact output array, so the caller
 * supplies the random source: `activate()` passes a real PRNG, tests pass a fixed-seed
 * PRNG. `rng` is `() => number` returning a value in `[0, 1)`, exactly like the global
 * random source but seedable. The function NEVER reads the global random source.
 *
 * The per-note random draw order is fixed and documented so a seeded run is exactly
 * reproducible: for each note, in note order, the function draws from `rng` only for
 * the axes whose gate is on, in the order **timing, then velocity, then duration**.
 * An axis whose `do*` flag is off draws nothing (so toggling `doDuration` does not
 * shift the timing/velocity draws of later notes). Swing is a deterministic positional
 * offset and draws no random value.
 */

import type { GridInfo, HumanizeOpts, NoteDTO } from '../dtos.js';
import { mapClipNotes } from './notes.js';

/** Velocity floor for a humanised note: 1, not 0 (a 0-velocity note is silent). */
export const MIN_HUMANIZED_VELOCITY = 1;
/** Velocity ceiling for a humanised note. */
export const MAX_HUMANIZED_VELOCITY = 127;

/**
 * The velocity a note is humanised around when it carries none of its own.
 * `NoteDTO.velocity` is optional; when `doVelocity` runs on a note with no velocity
 * we still want a stable, musically-sane base rather than `NaN`, so we centre on the
 * General-MIDI default of 100 (also the value Live writes for a freshly drawn note).
 */
const DEFAULT_VELOCITY = 100;

/**
 * Derive a {@link GridInfo} from the two raw grid fields the
 * {@link import('../dtos.js').SongOverview} reports (`gridQuantization` +
 * `gridIsTriplet`). The Set overview carries the label string and the triplet flag but
 * not the `beatsPerCell` width `humanize` scales its nudge to, so the handler runs the
 * raw pair through this before calling `humanize`.
 *
 * The mapping (one quarter note = 1 beat, per {@link GridInfo}) is
 * `beatsPerCell = (4 / denominator) * (isTriplet ? 2 / 3 : 1)`, where `denominator` is
 * the number under the `1/` in the label (`'1/16'` → 16). A label this code does not
 * recognise (e.g. `'None'`) falls back to a one-beat (quarter-note) cell; the handler
 * decides separately whether to apply Humanize at all in that case.
 *
 * Pure: no I/O, deterministic. Examples from the {@link GridInfo} table: `'1/16'`
 * straight → `0.25`; `'1/8'` triplet → `0.3333…`; `'1/4'` straight → `1`.
 */
export function gridInfoFrom(quantization: string, isTriplet: boolean): GridInfo {
  const beatsPerCell = beatsPerGridCell(quantization, isTriplet);
  return { quantization, isTriplet, beatsPerCell };
}

/** The width of one grid cell in beats, or a one-beat fallback for an unknown label. */
function beatsPerGridCell(quantization: string, isTriplet: boolean): number {
  // Parse the denominator out of a "1/N" label; anything else (e.g. "None") falls
  // back to a quarter-note cell so the nudge stays musically sane.
  const match = /^1\/(\d+)$/.exec(quantization.trim());
  const denominator = match ? Number(match[1]) : 0;
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return 1;
  }
  const straight = 4 / denominator;
  return isTriplet ? straight * (2 / 3) : straight;
}

/** Clamp a humanised velocity to 1..127 (distinct from the 0-floor `clampVelocity`). */
function clampHumanizedVelocity(velocity: number): number {
  if (velocity < MIN_HUMANIZED_VELOCITY) {
    return MIN_HUMANIZED_VELOCITY;
  }
  if (velocity > MAX_HUMANIZED_VELOCITY) {
    return MAX_HUMANIZED_VELOCITY;
  }
  return velocity;
}

/**
 * True for an off-beat note position, i.e. one that does not sit on a beat boundary.
 * Swing delays these. "Off-beat" is judged against the grid cell: a note whose start
 * falls on an odd-numbered grid cell (the `&` between beats) is off-beat. With a 1/8
 * straight grid (cell = 0.5 beats), beats 0.5, 1.5, … are off-beat and beats 0, 1, …
 * are on-beat.
 */
function isOffBeat(startTime: number, beatsPerCell: number): boolean {
  if (!(beatsPerCell > 0)) {
    return false;
  }
  const cellIndex = Math.round(startTime / beatsPerCell);
  return cellIndex % 2 !== 0;
}

/**
 * Humanize a clip's notes: nudge `startTime`, `velocity`, and optionally `duration`
 * by controlled random amounts scaled to the grid, with an optional swing on off-beat
 * positions and an optional "living" pass that writes `probability` /
 * `velocityDeviation`. Returns a fresh array of fresh notes; the input is never
 * mutated (the SDK read-map-assign contract).
 *
 * Scaling: a draw `rng()` in `[0, 1)` becomes a bipolar factor `rng() * 2 - 1` in
 * `[-1, 1)`. Timing offset is that factor times `grid.beatsPerCell * strength`, so at
 * `strength` 1 a note can move up to a full grid cell either way, and at `strength`
 * 0.5 up to half a cell ("up to ± half a grid cell", §2(b)). `startTime` is clamped at
 * 0 so no note starts before the clip. Velocity moves by the bipolar factor times
 * `strength * 64` (roughly half the velocity range at full strength) around the note's
 * own velocity (or {@link DEFAULT_VELOCITY} when it has none), then clamps to 1..127.
 * Duration jitter scales the duration by `1 + factor * strength * 0.5` and never drops
 * to zero or below.
 *
 * Swing is deterministic (no random draw): each off-beat note is delayed by
 * `swing * grid.beatsPerCell * 0.5`, the usual "push the & late" feel. It applies on
 * top of any timing nudge and is independent of the `doTiming` gate (swing is its own
 * control in the UI), but like every axis it vanishes at `strength` 0 via the early
 * return below.
 *
 * `strength` 0 is an exact identity transform (a structural copy, §2(f)): the early
 * return makes that hold no matter which gates or swing/living options are set.
 *
 * @param notes the clip notes to humanise (never mutated)
 * @param opts the per-axis gates and amounts from the Humanize modal
 * @param grid the Set grid, used to scale the timing nudge to a musically-sane bound
 * @param rng injected random source `() => number` in `[0, 1)`; a fixed-seed rng makes
 *   the output deterministic and assertable. Never the global random source.
 */
export function humanize(
  notes: readonly NoteDTO[],
  opts: HumanizeOpts,
  grid: GridInfo,
  rng: () => number,
): NoteDTO[] {
  // strength 0 (or below) is an identity transform: a fresh structural copy, with no
  // random draws, so the result is byte-for-byte the input regardless of the gates,
  // swing, or living flag. Mirrors the humanizeTiming precedent in notes.ts.
  if (!(opts.strength > 0)) {
    return mapClipNotes(notes, (note) => ({ ...note }));
  }

  const { strength } = opts;
  const swing = opts.swing ?? 0;
  const maxTimingOffset = grid.beatsPerCell * strength;

  return mapClipNotes(notes, (note) => {
    const next: NoteDTO = { ...note };

    // Draw in a fixed order — timing, velocity, duration — and only for gated axes, so
    // a seeded run is exactly reproducible and toggling one axis never shifts another's
    // draws. Build a mutable scratch object, then return it typed as NoteDTO.
    const out: {
      pitch: number;
      startTime: number;
      duration: number;
      velocity?: number;
      muted?: boolean;
      probability?: number;
      velocityDeviation?: number;
      releaseVelocity?: number;
      selected?: boolean;
    } = { ...next };

    if (opts.doTiming) {
      const factor = rng() * 2 - 1;
      out.startTime = note.startTime + factor * maxTimingOffset;
    }

    if (opts.doVelocity) {
      const factor = rng() * 2 - 1;
      const base = note.velocity ?? DEFAULT_VELOCITY;
      out.velocity = clampHumanizedVelocity(base + factor * strength * 64);
    }

    if (opts.doDuration) {
      const factor = rng() * 2 - 1;
      // Scale the duration by up to ±50% at full strength; never collapse to <= 0.
      const scaled = note.duration * (1 + factor * strength * 0.5);
      out.duration = scaled > 0 ? scaled : note.duration;
    }

    // Swing: deterministic positional delay on off-beats, on top of any timing nudge.
    if (swing > 0 && isOffBeat(note.startTime, grid.beatsPerCell)) {
      out.startTime += swing * grid.beatsPerCell * 0.5;
    }

    // Clamp start at 0 so no note begins before the clip (matches humanizeTiming).
    if (out.startTime < 0) {
      out.startTime = 0;
    }

    // Living pattern: write probability / velocityDeviation for a less mechanical feel
    // (§2(b)). Deterministic and scaled by strength so a fixed seed stays assertable.
    if (opts.living === true) {
      const probDraw = rng();
      // Keep probability high (notes still mostly play): 1 down to ~0.7 at full strength.
      out.probability = 1 - probDraw * strength * 0.3;
      out.velocityDeviation = rng() * strength * 16;
    }

    return out;
  });
}
