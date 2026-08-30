import { describe, expect, it } from 'vitest';

import {
  isSessionReferenceOfKind,
  makeSessionReference,
  parseSessionReference,
  SessionReferenceCollisionError,
  SessionReferenceExhaustedError,
  SessionReferenceParseError,
  SessionReferenceRegistry,
  tryParseSessionReference,
} from '../references.js';

const TOKEN_A = 'aaaaaaaaaaaaaaaa';
const TOKEN_B = 'bbbbbbbbbbbbbbbb';
const TOKEN_C = 'cccccccccccccccc';

function tokenSequence(...tokens: readonly string[]): () => string {
  let index = 0;
  return () => {
    const token = tokens[index];
    index += 1;
    if (token === undefined) {
      throw new Error('token sequence exhausted');
    }
    return token;
  };
}

describe('opaque session-reference shape', () => {
  it('uses a stable type tag and carries no positional path data', () => {
    const cases = [
      ['track', 'lhref_trk_'],
      ['scene', 'lhref_scn_'],
      ['cue-point', 'lhref_cue_'],
      ['clip-slot', 'lhref_slot_'],
      ['clip', 'lhref_clip_'],
      ['device', 'lhref_dev_'],
      ['parameter', 'lhref_param_'],
    ] as const;

    for (const [kind, prefix] of cases) {
      const reference = makeSessionReference(kind, TOKEN_A);
      expect(reference).toBe(`${prefix}${TOKEN_A}`);
      expect(reference).not.toContain('/');
      expect(reference).not.toContain(':');
      expect(parseSessionReference(reference)).toEqual({ reference, kind, token: TOKEN_A });
    }
  });

  it('strictly rejects malformed and retired positional reference formats', () => {
    const malformed = [
      '',
      'track:2',
      'track:2/clipslot:4/clip',
      'lhref_track_aaaaaaaaaaaaaaaa',
      'lhref_trk_short',
      'lhref_trk_aaaaaaaaaaaaaaa:',
      'lhref_trk_aaaaaaaaaaaaaaa/',
      'lhref_trk_aaaaaaaaaaaaaaa a',
      `lhref_trk_${'a'.repeat(129)}`,
    ];

    for (const candidate of malformed) {
      expect(() => parseSessionReference(candidate)).toThrow(SessionReferenceParseError);
      expect(tryParseSessionReference(candidate)).toBeNull();
    }
    expect(() => makeSessionReference('track', 'track:2/clip:0')).toThrow(
      SessionReferenceParseError,
    );
    expect(() => makeSessionReference('not-a-kind' as never, TOKEN_A)).toThrow(
      SessionReferenceParseError,
    );
  });

  it('narrows valid references by kind', () => {
    const track = makeSessionReference('track', TOKEN_A);
    expect(isSessionReferenceOfKind(track, 'track')).toBe(true);
    expect(isSessionReferenceOfKind(track, 'scene')).toBe(false);
  });
});

describe('SessionReferenceRegistry', () => {
  it('separates kinds and reports unknown or wrong-kind references explicitly', () => {
    const registry = new SessionReferenceRegistry<string>({
      tokenFactory: tokenSequence(TOKEN_A, TOKEN_B),
    });
    const track = registry.issue('track', 'Track identity');
    const scene = registry.issue('scene', 'Scene identity');

    expect(registry.resolve(track, 'track')).toMatchObject({
      status: 'found',
      kind: 'track',
      value: 'Track identity',
    });
    expect(registry.resolve(track, 'scene')).toEqual({
      status: 'wrong-kind',
      expectedKind: 'scene',
      actualKind: 'track',
    });
    expect(registry.resolve(scene, 'scene')).toMatchObject({ status: 'found' });
    expect(registry.resolve(makeSessionReference('track', TOKEN_C), 'track')).toEqual({
      status: 'unknown-or-expired',
    });
    expect(registry.resolve('track:0', 'track')).toEqual({
      status: 'unknown-or-expired',
    });
  });

  it('evicts the least recently used entry at its configured bound', () => {
    const registry = new SessionReferenceRegistry<number>({
      maxEntries: 2,
      tokenFactory: tokenSequence(TOKEN_A, TOKEN_B, TOKEN_C),
    });
    const first = registry.issue('track', 1);
    const second = registry.issue('scene', 2);

    expect(registry.resolve(first, 'track')).toMatchObject({ status: 'found' });
    const third = registry.issue('device', 3);

    expect(registry.size).toBe(2);
    expect(registry.resolve(second, 'scene')).toEqual({ status: 'unknown-or-expired' });
    expect(registry.resolve(first, 'track')).toMatchObject({ status: 'found', value: 1 });
    expect(registry.resolve(third, 'device')).toMatchObject({ status: 'found', value: 3 });
  });

  it('never reissues an evicted reference when its token repeats', () => {
    const registry = new SessionReferenceRegistry<number>({
      maxEntries: 1,
      tokenFactory: tokenSequence(TOKEN_A, TOKEN_B, TOKEN_A, TOKEN_C),
    });
    const expired = registry.issue('track', 1);
    registry.issue('track', 2);
    const current = registry.issue('track', 3);

    expect(current).toBe(`lhref_trk_${TOKEN_C}`);
    expect(registry.resolve(expired, 'track')).toEqual({ status: 'unknown-or-expired' });
    expect(registry.resolve(current, 'track')).toMatchObject({ status: 'found', value: 3 });
  });

  it('never reissues a forgotten reference when its token repeats', () => {
    const registry = new SessionReferenceRegistry<number>({
      tokenFactory: tokenSequence(TOKEN_A, TOKEN_A, TOKEN_B),
    });
    const forgotten = registry.issue('scene', 1);
    expect(registry.forget(forgotten)).toBe(true);
    const current = registry.issue('scene', 2);

    expect(current).toBe(`lhref_scn_${TOKEN_B}`);
    expect(registry.resolve(forgotten, 'scene')).toEqual({ status: 'unknown-or-expired' });
  });

  it('supports replacement, functional update, forgetting, and clearing', () => {
    const registry = new SessionReferenceRegistry<number>({
      tokenFactory: tokenSequence(TOKEN_A, TOKEN_B),
    });
    const reference = registry.issue('parameter', 1);

    expect(registry.replace(reference, 'parameter', 4)).toMatchObject({
      status: 'found',
      value: 4,
    });
    expect(registry.update(reference, 'parameter', (current) => current + 3)).toMatchObject({
      status: 'found',
      value: 7,
    });
    expect(registry.replace(reference, 'device', 9)).toMatchObject({
      status: 'wrong-kind',
    });
    expect(registry.forget(reference)).toBe(true);
    expect(registry.forget(reference)).toBe(false);
    expect(registry.resolve(reference, 'parameter')).toEqual({ status: 'unknown-or-expired' });

    registry.issue('clip', 8);
    registry.clear();
    expect(registry.size).toBe(0);
  });

  it('retries token collisions and fails after a bounded number of attempts', () => {
    const retrying = new SessionReferenceRegistry<string>({
      tokenFactory: tokenSequence(TOKEN_A, TOKEN_A, TOKEN_B),
    });
    retrying.issue('clip', 'first');
    const second = retrying.issue('clip', 'second');
    expect(second).toBe(`lhref_clip_${TOKEN_B}`);

    const exhausted = new SessionReferenceRegistry<string>({
      tokenFactory: () => TOKEN_A,
      maxTokenAttempts: 2,
    });
    exhausted.issue('device', 'first');
    expect(() => exhausted.issue('device', 'second')).toThrow(SessionReferenceCollisionError);
  });

  it('rejects invalid bounds and malformed tokens from a factory', () => {
    expect(() => new SessionReferenceRegistry({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new SessionReferenceRegistry({ maxTokenAttempts: 1.5 })).toThrow(RangeError);

    const registry = new SessionReferenceRegistry({ tokenFactory: () => 'not/opaque' });
    expect(() => registry.issue('track', {})).toThrow(SessionReferenceParseError);
  });

  it('enforces a documented lifetime issuance ceiling for retired references', () => {
    const registry = new SessionReferenceRegistry<number>({
      maxEntries: 1,
      maxIssuedReferences: 2,
      tokenFactory: tokenSequence(TOKEN_A, TOKEN_B),
    });
    registry.issue('track', 1);
    registry.issue('track', 2);

    expect(() => registry.issue('track', 3)).toThrow(SessionReferenceExhaustedError);
  });
});
