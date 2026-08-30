import { describe, expect, it, vi } from 'vitest';

import {
  parseGainStageModalRequest,
  validateGainStageAnalyzeRequest,
  type GainStageAnalyzeRequest,
} from './gain-stage-protocol.js';
import { dispatchValidatedModal } from './modal-validation.js';

describe('Gain Stage Doctor modal protocol', () => {
  it('accepts a finite, explicit analyze request and preserves opaque refs', () => {
    expect(
      parseGainStageModalRequest({ phase: 'analyze', targetDb: -18, trackIds: ['lhref_trk_a'] }),
    ).toEqual({
      phase: 'analyze',
      targetDb: -18,
      trackIds: ['lhref_trk_a'],
    });
  });

  it.each([-18, -20, -12])('accepts the shipped %d dB target', (targetDb) => {
    expect(
      parseGainStageModalRequest({ phase: 'analyze', targetDb, trackIds: ['lhref_trk_a'] }),
    ).toEqual({ phase: 'analyze', targetDb, trackIds: ['lhref_trk_a'] });
  });

  it('requires an explicit apply and treats malformed payloads as cancel', () => {
    expect(parseGainStageModalRequest({ phase: 'apply' })).toEqual({ phase: 'apply' });
    expect(
      parseGainStageModalRequest({ phase: 'analyze', targetDb: Number.NaN, trackIds: [] }),
    ).toBeNull();
    expect(
      parseGainStageModalRequest({ phase: 'analyze', targetDb: -18, trackIds: [42] }),
    ).toBeNull();
    expect(parseGainStageModalRequest({ phase: 'anything' })).toBeNull();
    expect(
      parseGainStageModalRequest({ phase: 'analyze', targetDb: -999, trackIds: [] }),
    ).toBeNull();
    expect(parseGainStageModalRequest({ phase: 'apply', extra: true })).toBeNull();
    expect(parseGainStageModalRequest({ phase: 'cancel', extra: true })).toBeNull();
    expect(
      parseGainStageModalRequest({
        phase: 'analyze',
        targetDb: Number.POSITIVE_INFINITY,
        trackIds: [],
      }),
    ).toBeNull();
  });

  it('does not dispatch a tampered finite target to analysis', async () => {
    const analyze = vi.fn(async (_request: GainStageAnalyzeRequest): Promise<void> => undefined);
    await expect(
      dispatchValidatedModal(
        JSON.stringify({ phase: 'analyze', targetDb: -999, trackIds: ['lhref_trk_a'] }),
        validateGainStageAnalyzeRequest,
        analyze,
      ),
    ).resolves.toBe(false);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('rejects arrays, inherited phases, custom prototypes, and throwing getters', () => {
    const inherited = Object.create({ phase: 'apply' });
    const customPrototype = Object.assign(Object.create({}), { phase: 'apply' });
    const throwing = new Proxy(
      { phase: 'apply' },
      {
        get: () => {
          throw new Error('getter trap');
        },
      },
    );

    expect(parseGainStageModalRequest([])).toBeNull();
    expect(parseGainStageModalRequest(inherited)).toBeNull();
    expect(parseGainStageModalRequest(customPrototype)).toBeNull();
    expect(parseGainStageModalRequest(throwing)).toBeNull();
  });
});
