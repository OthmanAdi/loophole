/**
 * Pure loudness math for Gain Stage Doctor (W3), 03_EXTENSIONS_SPEC §3.
 *
 * These functions have no I/O and touch neither the bridge nor the SDK. They consume
 * decoded PCM ({@link Float32Array} channels) and a mixer-volume descriptor as plain
 * data, and produce plain numbers. The audio decode itself is INJECTED into the
 * handler as a callback (see `../handlers/gain-stage-doctor.js`), so core never imports
 * `node:fs` or an audio-decode package; this file only does arithmetic on samples a
 * caller already decoded. They are the cheapest, fastest test ring (ring 1).
 *
 * Three jobs, one per exported function:
 *  - {@link analyzeLoudness}: measure peak / RMS / crest of a rendered region.
 *  - {@link suggestTrimDb}: how much gain change reaches a target RMS staging level.
 *  - {@link dbToParamValue}: turn that dB delta into the mixer volume's INTERNAL value.
 *
 * The dB model in {@link dbToParamValue} is a defensible monotonic stand-in, NOT the
 * measured Live curve: see the de-risk note on that function. Everything else
 * (analyze, suggest) is exact dB arithmetic with no unknowns.
 */

import type { LoudnessResult, MixerParam } from '../dtos.js';

/**
 * The dBFS floor reported for silence (or for any level at/below it), used instead of
 * `-Infinity` so the result is a finite, displayable, sortable number
 * (03_EXTENSIONS_SPEC §3(f): "silence (-∞ guarded)"). −120 dBFS sits well below the
 * noise floor of any real render, so it reads as "effectively silent" without poisoning
 * the crest-factor subtraction with `Infinity`/`NaN`.
 */
export const SILENCE_FLOOR_DB = -120;

/**
 * Convert a linear amplitude (0..1-ish, `|sample|`) to dBFS, flooring at
 * {@link SILENCE_FLOOR_DB}. `20·log10(amp)` is the standard amplitude-to-dB map; a
 * zero or sub-floor amplitude returns the guarded floor rather than `-Infinity`.
 */
function ampToDb(amp: number): number {
  if (!(amp > 0)) {
    return SILENCE_FLOOR_DB;
  }
  const db = 20 * Math.log10(amp);
  return db < SILENCE_FLOOR_DB ? SILENCE_FLOOR_DB : db;
}

/**
 * Measure the loudness of a rendered audio region (03_EXTENSIONS_SPEC §3(b)).
 *
 * Treats the channels as one interleaved signal: `peak` is `max|sample|` across every
 * sample of every channel, and `rms` is the root-mean-square across the same pooled
 * sample set (sum of squares over the total sample count, then `sqrt`). Both linear
 * amplitudes are converted to dBFS with {@link ampToDb}, and `crest = peakDb - rmsDb`.
 *
 * Guards (§3(f)):
 *  - **silence / empty:** no samples, or all-zero samples, yield
 *    `peakDb = rmsDb = SILENCE_FLOOR_DB` and `crest = 0` (not `NaN`/`-Infinity`).
 *  - **DC offset:** a constant non-zero signal has `peak == rms` in amplitude, so
 *    `crest` is `0` dB, which is the correct crest factor for DC.
 *
 * Pure: it reads the arrays and returns a fresh {@link LoudnessResult}; it never
 * mutates the input. Full-scale references for tests: a 0 dBFS sine peaks at ≈ 0 dBFS
 * and is ≈ −3.01 dBFS RMS; a full-scale square / DC is ≈ 0 dBFS on both.
 *
 * @param channels Decoded PCM, one {@link Float32Array} per channel. An empty array,
 *   or channels that are all empty, is treated as silence.
 */
export function analyzeLoudness(channels: readonly Float32Array[]): LoudnessResult {
  let peakAmp = 0;
  let sumSquares = 0;
  let sampleCount = 0;

  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      // noUncheckedIndexedAccess: a typed-array index is `number | undefined` to TS,
      // so coerce the in-bounds read to a number (NaN-guarded below by Math).
      const sample = channel[i] ?? 0;
      const abs = sample < 0 ? -sample : sample;
      if (abs > peakAmp) {
        peakAmp = abs;
      }
      sumSquares += sample * sample;
      sampleCount += 1;
    }
  }

  if (sampleCount === 0) {
    // No samples at all: report the guarded silence floor with a 0 dB crest.
    return { peakDb: SILENCE_FLOOR_DB, rmsDb: SILENCE_FLOOR_DB, crest: 0 };
  }

  const rmsAmp = Math.sqrt(sumSquares / sampleCount);
  const peakDb = ampToDb(peakAmp);
  const rmsDb = ampToDb(rmsAmp);
  return { peakDb, rmsDb, crest: peakDb - rmsDb };
}

/**
 * The gain change, in dB, that moves a measured RMS level to a target RMS staging
 * level (03_EXTENSIONS_SPEC §3(b)): `trimDb = targetDb - rmsDb`. A track quieter than
 * the target yields a positive trim (turn up); a louder track yields a negative trim
 * (turn down). Worked example from the spec: `suggestTrimDb(-9, -18) === -9` (a track
 * at −9 dBFS RMS needs −9 dB to reach a −18 dBFS target).
 *
 * Pure arithmetic, no clamping: the dB delta is exact. The clamp to the mixer's
 * internal range happens later, in {@link dbToParamValue}.
 */
export function suggestTrimDb(rmsDb: number, targetDb: number): number {
  return targetDb - rmsDb;
}

/**
 * The assumed dB span from the mixer volume's INTERNAL minimum up to unity
 * (`defaultValue`), used to derive the model slope in {@link dbToParamValue}.
 *
 * Live's volume fader runs from a practical floor near silence up through 0 dB
 * (unity) to roughly +6 dB at the top, but the EXACT internal-value-to-dB curve is
 * not exposed by the SDK and is the flagged W3 de-risk (03_EXTENSIONS_SPEC §3(d)).
 * 70 dB is a deliberately conservative stand-in for "min to unity" so the slope is
 * defensible and gentle; it MUST be replaced with a value fit to the measured curve
 * (sweep `setValue`/`getValue` across `min..max` in real Live) before any dB label in
 * the UI is trusted. Changing this constant changes only the magnitude of the mapping,
 * never its monotonicity or the `0 dB → defaultValue` anchor.
 */
export const ASSUMED_DB_FROM_MIN_TO_UNITY = 70;

/**
 * Map a dB gain delta to the mixer volume `DeviceParameter`'s INTERNAL value
 * (03_EXTENSIONS_SPEC §3(b)).
 *
 * **The model (documented stand-in, NOT the measured Live curve).** A single linear
 * slope in internal-units-per-dB, anchored so that a `0 dB` delta maps exactly to the
 * parameter's `defaultValue` (its unity-gain point). The slope is derived from the
 * lower half of the range, `(defaultValue - min) / ASSUMED_DB_FROM_MIN_TO_UNITY`, and
 * applied symmetrically; the result is clamped to `[min, max]`. This makes the map:
 *  - **monotonic:** more dB never decreases the value (a positive slope, then a clamp),
 *  - **anchored:** `dbToParamValue(0, p) === p.defaultValue` exactly (the unity point),
 *  - **bounded:** a large trim cannot push the fader past its rails.
 *
 * **Why this is a stand-in (the flagged W3 de-risk, 03_EXTENSIONS_SPEC §3(d)).** The
 * SDK exposes `min` / `max` / `defaultValue` and `get/setValue` in INTERNAL units, but
 * NOT the internal-value↔dB curve, which is non-linear on a real Live fader. Before any
 * dB label in the UI is trusted, the curve MUST be swept on the build machine (read the
 * three bounds, call `setValue`/`getValue` across the range, fit this function to the
 * measurements). Until then this monotonic linear model is a safe, predictable
 * placeholder: directionally correct (down-trims lower the fader, up-trims raise it) and
 * never out of range, but its exact dB-per-step is approximate. Ring 3 verifies it.
 *
 * Degenerate guard: if the slope cannot be formed (a zero or negative `defaultValue -
 * min`, i.e. unity sits at or below the floor), the function returns `defaultValue`
 * clamped into range, so it still honours the `0 dB → unity` contract without dividing
 * by zero.
 *
 * @param db The dB gain delta to apply (e.g. the output of {@link suggestTrimDb}).
 * @param p The mixer volume's internal `min` / `max` / `defaultValue`
 *   ({@link MixerParam}); a structural subset of the volume {@link DeviceParamInfo}, so
 *   a handler passes the read-back volume parameter straight in.
 */
export function dbToParamValue(db: number, p: MixerParam): number {
  const unity = p.defaultValue;
  const span = unity - p.min;
  // No usable lower span to derive a slope from: hold unity (still clamped to range).
  if (!(span > 0)) {
    return clampToRange(unity, p.min, p.max);
  }
  const unitsPerDb = span / ASSUMED_DB_FROM_MIN_TO_UNITY;
  const raw = unity + db * unitsPerDb;
  return clampToRange(raw, p.min, p.max);
}

/** Clamp `value` into the inclusive `[min, max]` internal range. */
function clampToRange(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
