/**
 * Ring 1 unit tests for the pure loudness math (Gain Stage Doctor, W3,
 * 03_EXTENSIONS_SPEC §3(f)). No bridge, no I/O, no audio file: synthetic
 * Float32Arrays with hand-checked dB answers.
 *
 * References used below:
 *  - a full-scale sine (amplitude 1.0) peaks at 0 dBFS and is 20·log10(1/√2)
 *    = −3.0103 dBFS RMS, a 3.0103 dB crest;
 *  - silence and DC are the two guarded edge cases (§3(f)): silence floors to a finite
 *    value with a 0 dB crest, DC has peak == rms so a 0 dB crest;
 *  - suggestTrimDb(−9, −18) === −9 is the worked example from §3(b);
 *  - dbToParamValue must be monotonic and map 0 dB to the parameter's defaultValue.
 */

import { describe, expect, it } from 'vitest';

import type { MixerParam } from '../dtos.js';
import {
  ASSUMED_DB_FROM_MIN_TO_UNITY,
  analyzeLoudness,
  dbToParamValue,
  SILENCE_FLOOR_DB,
  suggestTrimDb,
} from '../transforms/loudness.js';

/** A full-scale (amplitude 1.0) sine over `samples` points, one cycle per `period`. */
function fullScaleSine(samples = 4096, period = 256): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = Math.sin((2 * Math.PI * i) / period);
  }
  return out;
}

/** A constant-amplitude (DC) signal of `value` over `samples` points. */
function dc(value: number, samples = 1024): Float32Array {
  return new Float32Array(samples).fill(value);
}

describe('analyzeLoudness: full-scale sine', () => {
  const result = analyzeLoudness([fullScaleSine()]);

  it('peaks at ~0 dBFS', () => {
    expect(result.peakDb).toBeCloseTo(0, 2);
  });

  it('is ~ -3.01 dBFS RMS (sine RMS = 1/sqrt(2))', () => {
    expect(result.rmsDb).toBeCloseTo(-3.0103, 2);
  });

  it('has a ~3.01 dB crest factor (peakDb - rmsDb)', () => {
    expect(result.crest).toBeCloseTo(3.0103, 2);
    expect(result.crest).toBeCloseTo(result.peakDb - result.rmsDb, 10);
  });

  it('pools all channels: a stereo sine reports the same single-channel levels', () => {
    const mono = analyzeLoudness([fullScaleSine()]);
    const stereo = analyzeLoudness([fullScaleSine(), fullScaleSine()]);
    expect(stereo.peakDb).toBeCloseTo(mono.peakDb, 6);
    expect(stereo.rmsDb).toBeCloseTo(mono.rmsDb, 6);
  });
});

describe('analyzeLoudness: silence is guarded (no -Infinity / NaN)', () => {
  it('all-zero samples floor to SILENCE_FLOOR_DB with a 0 dB crest', () => {
    const result = analyzeLoudness([new Float32Array(1024)]);
    expect(result.peakDb).toBe(SILENCE_FLOOR_DB);
    expect(result.rmsDb).toBe(SILENCE_FLOOR_DB);
    expect(result.crest).toBe(0);
    expect(Number.isFinite(result.peakDb)).toBe(true);
    expect(Number.isFinite(result.rmsDb)).toBe(true);
  });

  it('no channels at all is treated as silence', () => {
    const result = analyzeLoudness([]);
    expect(result.peakDb).toBe(SILENCE_FLOOR_DB);
    expect(result.rmsDb).toBe(SILENCE_FLOOR_DB);
    expect(result.crest).toBe(0);
  });

  it('empty channels are treated as silence', () => {
    const result = analyzeLoudness([new Float32Array(0), new Float32Array(0)]);
    expect(result.rmsDb).toBe(SILENCE_FLOOR_DB);
  });
});

describe('analyzeLoudness: DC offset has peak == rms (0 dB crest)', () => {
  it('full-scale DC (1.0) is ~0 dBFS on both peak and rms', () => {
    const result = analyzeLoudness([dc(1)]);
    expect(result.peakDb).toBeCloseTo(0, 6);
    expect(result.rmsDb).toBeCloseTo(0, 6);
    expect(result.crest).toBeCloseTo(0, 6);
  });

  it('half-scale DC (0.5) is ~ -6.02 dBFS on both peak and rms', () => {
    const result = analyzeLoudness([dc(0.5)]);
    expect(result.peakDb).toBeCloseTo(-6.0206, 3);
    expect(result.rmsDb).toBeCloseTo(-6.0206, 3);
    expect(result.crest).toBeCloseTo(0, 6);
  });

  it('a negative DC level measures by magnitude (|sample|)', () => {
    const result = analyzeLoudness([dc(-0.5)]);
    expect(result.peakDb).toBeCloseTo(-6.0206, 3);
    expect(result.rmsDb).toBeCloseTo(-6.0206, 3);
  });
});

describe('suggestTrimDb: targetDb - rmsDb', () => {
  it('matches the spec worked example: suggestTrimDb(-9, -18) === -9', () => {
    expect(suggestTrimDb(-9, -18)).toBe(-9);
  });

  it('a track quieter than target needs a positive trim (turn up)', () => {
    expect(suggestTrimDb(-24, -18)).toBe(6);
  });

  it('a track already at target needs no trim', () => {
    expect(suggestTrimDb(-18, -18)).toBe(0);
  });
});

describe('dbToParamValue: monotonic, anchored at unity, clamped', () => {
  // A Live-mixer-like volume param: 0..1 internal, unity (0 dB) at 0.85.
  const vol: MixerParam = { min: 0, max: 1, defaultValue: 0.85 };

  it('maps 0 dB exactly to the defaultValue (unity)', () => {
    expect(dbToParamValue(0, vol)).toBe(0.85);
  });

  it('is monotonic non-decreasing across a dB sweep', () => {
    const dbs = [-60, -36, -18, -9, -6, -3, 0, 3, 6, 12, 24];
    const values = dbs.map((db) => dbToParamValue(db, vol));
    for (let i = 1; i < values.length; i += 1) {
      // Each step up in dB never lowers the internal value.
      expect(values[i]! >= values[i - 1]!).toBe(true);
    }
  });

  it('a negative trim lowers the fader below unity, a positive trim raises it', () => {
    expect(dbToParamValue(-9, vol)).toBeLessThan(0.85);
    expect(dbToParamValue(6, vol)).toBeGreaterThan(0.85);
  });

  it('clamps to [min, max] for extreme trims (never off the rails)', () => {
    expect(dbToParamValue(-1000, vol)).toBe(0);
    expect(dbToParamValue(1000, vol)).toBe(1);
  });

  it('uses the documented linear slope: -ASSUMED_DB_FROM_MIN_TO_UNITY dB reaches min', () => {
    // span = defaultValue - min = 0.85; slope = span / ASSUMED_DB_FROM_MIN_TO_UNITY.
    // At db = -ASSUMED_DB_FROM_MIN_TO_UNITY the model lands exactly on min (0).
    expect(dbToParamValue(-ASSUMED_DB_FROM_MIN_TO_UNITY, vol)).toBeCloseTo(0, 10);
    // Halfway down is halfway between min and unity.
    expect(dbToParamValue(-ASSUMED_DB_FROM_MIN_TO_UNITY / 2, vol)).toBeCloseTo(0.425, 10);
  });

  it('holds unity when there is no usable lower span (defaultValue == min)', () => {
    const degenerate: MixerParam = { min: 0.5, max: 1, defaultValue: 0.5 };
    expect(dbToParamValue(-12, degenerate)).toBe(0.5);
    expect(dbToParamValue(12, degenerate)).toBeGreaterThanOrEqual(0.5);
  });
});
