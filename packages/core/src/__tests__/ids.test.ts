import { describe, expect, it } from 'vitest';

import {
  isSessionReferenceOfKind,
  makeSessionReference,
  parseSessionReference,
  SessionReferenceRegistry,
  tryParseSessionReference,
} from '../references.js';

const TOKEN_A = 'abcdefghijklmnop';
const TOKEN_B = 'qrstuvwxyzABCDEF';

describe('opaque session references', () => {
  it('uses type-tagged values with no positional path content', () => {
    const ref = makeSessionReference('track', TOKEN_A);
    expect(ref).toBe(`lhref_trk_${TOKEN_A}`);
    expect(ref).not.toContain('track:');
    expect(ref).not.toContain('clipslot:');
    expect(parseSessionReference(ref)).toMatchObject({ kind: 'track', token: TOKEN_A });
    expect(isSessionReferenceOfKind(ref, 'track')).toBe(true);
    expect(isSessionReferenceOfKind(ref, 'clip')).toBe(false);
  });

  it('rejects legacy positional paths and malformed values', () => {
    expect(tryParseSessionReference('track:0')).toBeNull();
    expect(tryParseSessionReference('lhref_trk_short')).toBeNull();
    expect(tryParseSessionReference('lhref_unknown_abcdefghijklmnop')).toBeNull();
  });

  it('expires least-recently-used references fail closed', () => {
    const tokens = [TOKEN_A, TOKEN_B, '0123456789abcdef'];
    let index = 0;
    const registry = new SessionReferenceRegistry<number>({
      maxEntries: 2,
      tokenFactory: () => tokens[index++] ?? 'fedcba9876543210',
    });
    const first = registry.issue('track', 1);
    registry.issue('track', 2);
    registry.issue('track', 3);
    expect(registry.resolve(first, 'track')).toEqual({ status: 'unknown-or-expired' });
  });
});
