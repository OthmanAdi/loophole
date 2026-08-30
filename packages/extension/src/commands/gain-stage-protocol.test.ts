import { describe, expect, it } from 'vitest';

import { parseGainStageModalRequest } from './gain-stage-protocol.js';

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

  it('requires an explicit apply and treats malformed payloads as cancel', () => {
    expect(parseGainStageModalRequest({ phase: 'apply' })).toEqual({ phase: 'apply' });
    expect(
      parseGainStageModalRequest({ phase: 'analyze', targetDb: Number.NaN, trackIds: [] }),
    ).toBeNull();
    expect(
      parseGainStageModalRequest({ phase: 'analyze', targetDb: -18, trackIds: [42] }),
    ).toBeNull();
    expect(parseGainStageModalRequest({ phase: 'anything' })).toBeNull();
  });
});
