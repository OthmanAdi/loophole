/**
 * Ring 2 tests for the Gain Stage Doctor handler against FakeLiveBridge
 * (03_EXTENSIONS_SPEC §3(f)). No Ableton, no real WAV: the WAV decode is INJECTED as a
 * fake returning fixture Float32Array channels straight past the I/O boundary, and the
 * fake track is seeded with a known mixer volume.
 *
 * The two headline assertions:
 *  1. each track's stored volume == dbToParamValue(suggestTrimDb(rmsDb, targetDb), vol)
 *     — the read → measure → suggest → map → write round-trip lands the right value;
 *  2. the whole multi-track write batch is exactly ONE transaction (one undo), per the
 *     §3(b) `transaction(() => Promise.all(setParam …))` contract and the cross-cutting
 *     "one tool call = one transaction = one undo" rule.
 *
 * RING-3 DE-RISK (flagged, NOT covered here): the exact dB→internal-value curve baked
 * into dbToParamValue is a documented linear stand-in (ASSUMED_DB_FROM_MIN_TO_UNITY).
 * The REAL Live mixer-volume curve is non-linear and is NOT exposed by the SDK, so the
 * dB labels these tests assert are only as accurate as that stand-in. Before trusting
 * any dB figure in the UI, the curve must be swept in real Live (read min/max/
 * defaultValue, sweep setValue/getValue, fit dbToParamValue) — that is the W3 ring-3
 * step (03_EXTENSIONS_SPEC §3(d)). These ring-2 assertions pin the WIRING and the
 * one-undo grouping, not the physical dB accuracy.
 */

import { describe, expect, it } from 'vitest';

import { FakeLiveBridge } from '../fake-live-bridge.js';
import { isBridgeErrorOfCode } from '../errors.js';
import { trackId } from '../ids.js';
import type { TrackId } from '../ids.js';
import { analyzeLoudness, dbToParamValue, suggestTrimDb } from '../transforms/loudness.js';
import { runGainStageDoctor } from '../handlers/gain-stage-doctor.js';
import type { DecodeWav } from '../handlers/gain-stage-doctor.js';

/** A constant-amplitude (DC) channel of `value`, a clean known RMS for the fixtures. */
function dc(value: number, samples = 1024): Float32Array {
  return new Float32Array(samples).fill(value);
}

/**
 * A decode that ignores the path and returns the same fixture channels for every
 * track, while recording which paths it was handed (to prove the handler decodes the
 * render output). Mirrors the injected `fs.readFile + audio-decode` boundary.
 */
function fakeDecode(channels: Float32Array[]): { decode: DecodeWav; paths: string[] } {
  const paths: string[] = [];
  const decode: DecodeWav = (wavPath) => {
    paths.push(wavPath);
    // Fresh copies so the handler can never alias the fixture across tracks.
    return Promise.resolve(channels.map((c) => c.slice()));
  };
  return { decode, paths };
}

describe('runGainStageDoctor: read → measure → suggest → map → write (one undo)', () => {
  const TARGET_DB = -18;

  it('stores volume == dbToParamValue(suggestTrimDb(rmsDb, target), vol) for the track', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const id = trackId(0); // the Gtr audio track, mixer volume 0.6, unity 0.85
    const fixture = [dc(0.5)]; // half-scale DC → rms = -6.0206 dBFS (a clean known level)
    const { decode } = fakeDecode(fixture);

    // Compute the expected stored value with the SAME pure functions the handler uses.
    const vol = bridge.getTrackMixer(id).volume;
    const { rmsDb } = analyzeLoudness(fixture);
    const expectedTrim = suggestTrimDb(rmsDb, TARGET_DB);
    const expectedValue = dbToParamValue(expectedTrim, vol);

    const result = await runGainStageDoctor(
      bridge,
      { trackIds: [id], targetDb: TARGET_DB },
      decode,
    );

    // The reported row matches the measurement.
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.track).toBe('Gtr');
    expect(result.rows[0]?.rmsDb).toBeCloseTo(rmsDb, 10);
    expect(result.rows[0]?.trimDb).toBeCloseTo(expectedTrim, 10);

    // The stored mixer volume is exactly the mapped value (a fresh read sees the write).
    expect(bridge.getTrackMixer(id).volume.value).toBeCloseTo(expectedValue, 10);
  });

  it('writes the whole trim batch as exactly ONE transaction (one undo)', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const { decode } = fakeDecode([dc(0.5)]);
    expect(bridge.transactionCount).toBe(0);

    await runGainStageDoctor(bridge, { trackIds: [trackId(0)], targetDb: TARGET_DB }, decode);

    // One render (no undo step) + one setParam batch grouped in one transaction.
    expect(bridge.transactionCount).toBe(1);
  });

  it('groups MULTIPLE tracks into exactly ONE undo (the §3(b) one-undo-across-all claim)', async () => {
    // The single-track case cannot distinguish "one batch" from "one transaction per
    // track" (both grow transactionCount by 1). Two audio tracks pin it: the whole
    // batch must be ONE undo, not one-per-track. Build a second audio track through the
    // port (no fixture ships with two), so track 0 (Gtr, clip [0,8)) and track 1 (no
    // arrangement clips → deriveRenderRange falls back to [0,4]) are both staged.
    const bridge = FakeLiveBridge.seededAudioTrack();
    await bridge.createTrack('audio'); // track 1, audio, no clips
    // Snapshot AFTER setup: createTrack itself commits one undo step.
    const before = bridge.transactionCount;

    const fixture = [dc(0.5)];
    const { decode } = fakeDecode(fixture);
    const ids = [trackId(0), trackId(1)];

    await runGainStageDoctor(bridge, { trackIds: ids, targetDb: TARGET_DB }, decode);

    // Both setParam writes collapse into a SINGLE transaction. If the handler ever
    // moved transaction(...) inside the per-track loop this would read `before + 2`.
    expect(bridge.transactionCount).toBe(before + 1);

    // Both tracks landed the mapped value (each computed with the same pure functions).
    const { rmsDb } = analyzeLoudness(fixture);
    for (const id of ids) {
      const vol = bridge.getTrackMixer(id).volume;
      const expected = dbToParamValue(suggestTrimDb(rmsDb, TARGET_DB), vol);
      expect(bridge.getTrackMixer(id).volume.value).toBeCloseTo(expected, 10);
    }
  });

  it('decodes the path that renderTrack returned (the render → decode boundary)', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const { decode, paths } = fakeDecode([dc(0.5)]);

    await runGainStageDoctor(bridge, { trackIds: [trackId(0)], targetDb: TARGET_DB }, decode);

    // The Gtr arrangement clip spans [0, 8); the fake renders that range to a wav path.
    expect(paths.length).toBe(1);
    expect(paths[0]).toBe('/tmp/loophole/render/Gtr_0-8.wav');
  });

  it('a louder track gets a negative trim that lowers the fader below unity', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const id = trackId(0);
    // Full-scale DC (1.0) → rms ~0 dBFS, far above the -18 target → a large down-trim.
    const { decode } = fakeDecode([dc(1)]);

    await runGainStageDoctor(bridge, { trackIds: [id], targetDb: TARGET_DB }, decode);

    const stored = bridge.getTrackMixer(id).volume.value;
    expect(stored).toBeLessThan(0.85); // below unity (a cut)
    expect(stored).toBeGreaterThanOrEqual(0); // still on the rails
  });

  it('silence yields the guarded floor and a large up-trim (clamped to max)', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const id = trackId(0);
    const { decode } = fakeDecode([new Float32Array(1024)]); // silence

    const result = await runGainStageDoctor(
      bridge,
      { trackIds: [id], targetDb: TARGET_DB },
      decode,
    );

    // rmsDb floored well below target → a big positive trim → fader clamps up to max.
    expect(result.rows[0]?.rmsDb).toBeLessThan(TARGET_DB);
    expect(bridge.getTrackMixer(id).volume.value).toBe(1);
  });

  it('opens no transaction when there are no tracks to stage', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const { decode } = fakeDecode([dc(0.5)]);

    const result = await runGainStageDoctor(bridge, { trackIds: [], targetDb: TARGET_DB }, decode);

    expect(result.rows).toEqual([]);
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects a non-audio track via the port (renderTrack WRONG_TYPE)', async () => {
    // The broad seeded Set: track 0 (Drums) is a MIDI track, which renderPreFxAudio
    // refuses. The handler surfaces the port's typed error rather than swallowing it.
    const bridge = FakeLiveBridge.seeded();
    const midi: TrackId = trackId(0);
    const { decode } = fakeDecode([dc(0.5)]);

    await expect(
      runGainStageDoctor(bridge, { trackIds: [midi], targetDb: TARGET_DB }, decode),
    ).rejects.toSatisfy((e: unknown) => isBridgeErrorOfCode(e, 'WRONG_TYPE'));
    // Nothing was written.
    expect(bridge.transactionCount).toBe(0);
  });
});
