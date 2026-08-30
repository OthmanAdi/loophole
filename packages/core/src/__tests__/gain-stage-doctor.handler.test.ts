import { describe, expect, it, vi } from 'vitest';

import { isBridgeErrorOfCode } from '../errors.js';
import { FakeLiveBridge } from '../fake-live-bridge.js';
import {
  analyzeGainStageDoctor,
  applyGainStageDoctor,
  type DecodeWav,
} from '../handlers/gain-stage-doctor.js';
import type { TrackId } from '../ids.js';
import { analyzeLoudness, dbToParamValue, suggestTrimDb } from '../transforms/loudness.js';

const TARGET_DB = -18;

function dc(value: number, samples = 1024): Float32Array {
  return new Float32Array(samples).fill(value);
}

function fakeDecode(channels: Float32Array[]): { decode: DecodeWav; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    decode: (path) => {
      paths.push(path);
      return Promise.resolve(channels.map((channel) => channel.slice()));
    },
  };
}

function trackIdAt(bridge: FakeLiveBridge, index: number): TrackId {
  const track = bridge.listTracks()[index];
  if (track === undefined) throw new Error(`Missing fixture track ${String(index)}`);
  return track.id;
}

describe('Gain Stage Doctor: analyze before explicit apply', () => {
  it('analysis measures and proposes a trim without opening a transaction or writing', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const id = trackIdAt(bridge, 0);
    const original = (await bridge.getTrackMixer(id)).volume.value;
    const fixture = [dc(0.5)];
    const { decode, paths } = fakeDecode(fixture);

    const plan = await analyzeGainStageDoctor(
      bridge,
      { trackIds: [id], targetDb: TARGET_DB },
      decode,
    );

    const proposal = plan.proposals[0];
    if (proposal === undefined || proposal.status !== 'proposed')
      throw new Error('Missing proposal');
    const volume = (await bridge.getTrackMixer(id)).volume;
    const expected = dbToParamValue(
      suggestTrimDb(analyzeLoudness(fixture).rmsDb, TARGET_DB),
      volume,
    );
    expect(proposal.proposedValue).toBeCloseTo(expected, 10);
    expect(paths).toEqual(['/tmp/loophole/render/Gtr_0-8.wav']);
    expect(bridge.transactionCount).toBe(0);
    expect((await bridge.getTrackMixer(id)).volume.value).toBe(original);
  });

  it('explicit apply writes all proposed targets in one transaction', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    await bridge.createTrack('audio');
    const ids = [trackIdAt(bridge, 0), trackIdAt(bridge, 1)];
    const before = bridge.transactionCount;
    const plan = await analyzeGainStageDoctor(
      bridge,
      { trackIds: ids, targetDb: TARGET_DB },
      fakeDecode([dc(1)]).decode,
    );

    const result = await applyGainStageDoctor(bridge, plan);

    expect(result.appliedCount).toBe(2);
    expect(bridge.transactionCount).toBe(before + 1);
  });

  it('a silent render is reviewed as skipped and cannot boost the fader', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const id = trackIdAt(bridge, 0);
    const original = (await bridge.getTrackMixer(id)).volume.value;
    const plan = await analyzeGainStageDoctor(
      bridge,
      { trackIds: [id], targetDb: TARGET_DB },
      fakeDecode([new Float32Array(1024)]).decode,
    );

    expect(plan.proposals[0]).toMatchObject({ status: 'silence', trimDb: 0 });
    await expect(applyGainStageDoctor(bridge, plan)).resolves.toEqual({ appliedCount: 0 });
    expect(bridge.transactionCount).toBe(0);
    expect((await bridge.getTrackMixer(id)).volume.value).toBe(original);
  });

  it('fails closed before a transaction when a reviewed target no longer matches', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const id = trackIdAt(bridge, 0);
    const plan = await analyzeGainStageDoctor(
      bridge,
      { trackIds: [id], targetDb: TARGET_DB },
      fakeDecode([dc(1)]).decode,
    );
    const proposal = plan.proposals[0];
    if (proposal === undefined || proposal.status !== 'proposed')
      throw new Error('Missing proposal');
    const stalePlan = {
      ...plan,
      proposals: [
        { ...proposal, volumeParamId: 'lhref_param_wrong' as typeof proposal.volumeParamId },
      ],
    };

    await expect(applyGainStageDoctor(bridge, stalePlan)).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'STALE_REFERENCE'),
    );
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects a corrupted non-finite plan before any mixer write', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const id = trackIdAt(bridge, 0);
    const plan = await analyzeGainStageDoctor(
      bridge,
      { trackIds: [id], targetDb: TARGET_DB },
      fakeDecode([dc(1)]).decode,
    );
    const proposal = plan.proposals[0];
    if (proposal === undefined || proposal.status !== 'proposed')
      throw new Error('Missing proposal');
    const corrupted = {
      ...plan,
      proposals: [{ ...proposal, proposedValue: Number.NaN }],
    };

    await expect(applyGainStageDoctor(bridge, corrupted)).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects corrupt review measurements before any bridge read, write, or transaction', async () => {
    const bridge = FakeLiveBridge.seededAudioTrack();
    const id = trackIdAt(bridge, 0);
    const plan = await analyzeGainStageDoctor(
      bridge,
      { trackIds: [id], targetDb: TARGET_DB },
      fakeDecode([dc(1)]).decode,
    );
    const proposal = plan.proposals[0];
    if (proposal === undefined || proposal.status !== 'proposed')
      throw new Error('Missing proposal');
    const getTrackMixer = vi.spyOn(bridge, 'getTrackMixer');
    const setParam = vi.spyOn(bridge, 'setParam');
    const transaction = vi.spyOn(bridge, 'transaction');
    const corrupted = {
      targetDb: Number.NaN,
      proposals: [{ ...proposal, rmsDb: Number.POSITIVE_INFINITY }],
    };

    await expect(applyGainStageDoctor(bridge, corrupted)).rejects.toSatisfy((error: unknown) =>
      isBridgeErrorOfCode(error, 'BAD_INPUT'),
    );
    expect(getTrackMixer).not.toHaveBeenCalled();
    expect(setParam).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(bridge.transactionCount).toBe(0);
  });

  it('rejects non-audio tracks and invalid decoded samples without writes', async () => {
    const midiBridge = FakeLiveBridge.seeded();
    await expect(
      analyzeGainStageDoctor(
        midiBridge,
        { trackIds: [trackIdAt(midiBridge, 0)], targetDb: TARGET_DB },
        fakeDecode([dc(0.5)]).decode,
      ),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'WRONG_TYPE'));

    const audioBridge = FakeLiveBridge.seededAudioTrack();
    const samples = new Float32Array([0, 1]);
    samples[1] = Number.NaN;
    await expect(
      analyzeGainStageDoctor(
        audioBridge,
        { trackIds: [trackIdAt(audioBridge, 0)], targetDb: TARGET_DB },
        fakeDecode([samples]).decode,
      ),
    ).rejects.toSatisfy((error: unknown) => isBridgeErrorOfCode(error, 'BAD_INPUT'));
    expect(audioBridge.transactionCount).toBe(0);
  });
});
