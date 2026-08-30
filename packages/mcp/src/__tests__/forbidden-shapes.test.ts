/**
 * Negative control for `assertNoForbiddenShapes` (the harness scanner).
 *
 * The scanner backs the first-class claim that no `Handle`/`bigint` ever crosses
 * the MCP wire (02_BRIDGE_SPEC §3, §8). Every integration test feeds it CLEAN
 * payloads, so without a negative control a silent no-op bug in the walker would
 * let every "no forbidden shape" assertion pass vacuously. These tests plant the
 * forbidden shapes and assert the scanner THROWS, proving it actually inspects the
 * graph; and confirm it passes a clean opaque-reference payload.
 */

import { describe, expect, it } from 'vitest';

import { assertNoForbiddenShapes } from './harness.js';

describe('assertNoForbiddenShapes catches forbidden host shapes (negative control)', () => {
  it('throws on a bigint anywhere in the graph', () => {
    expect(() => assertNoForbiddenShapes({ tempo: 120, weird: 5n })).toThrow(/bigint/i);
  });

  it('throws on a bigint nested inside an array', () => {
    expect(() =>
      assertNoForbiddenShapes({ notes: [{ pitch: 60 }, { pitch: 9007199254740993n }] }),
    ).toThrow(/bigint/i);
  });

  it('throws on a property literally named "handle" (the SDK reference type)', () => {
    expect(() => assertNoForbiddenShapes({ track: { name: 'Bass', handle: { id: 7n } } })).toThrow(
      /handle/i,
    );
  });

  it('throws on a numeric id (host id) where a string reference is required', () => {
    expect(() => assertNoForbiddenShapes({ id: 42, name: 'Drums' })).toThrow(/numeric id/i);
  });

  it('throws on locator or fingerprint keys at any nesting depth', () => {
    expect(() => assertNoForbiddenShapes({ locator: 'song.tracks[0]' })).toThrow(
      /locator\/fingerprint/i,
    );
    expect(() =>
      assertNoForbiddenShapes({ nested: { structuralFingerprint: 'track:0|clip:1' } }),
    ).toThrow(/locator\/fingerprint/i);
  });

  it('throws on legacy positional or malformed values in reference-named fields', () => {
    expect(() => assertNoForbiddenShapes({ trackId: 'track:0' })).toThrow(/positional reference/i);
    expect(() => assertNoForbiddenShapes({ clipId: 'lhref_clip_too-short' })).toThrow(
      /malformed or positional reference/i,
    );
    expect(() => assertNoForbiddenShapes({ parameterId: 99 })).toThrow(/numeric id\/reference/i);
  });

  it('allows intentional numeric domain metadata such as sceneIndex', () => {
    expect(() =>
      assertNoForbiddenShapes({
        id: 'lhref_scn_0123456789abcdef',
        sceneIndex: 2,
        count: 3,
      }),
    ).not.toThrow();
  });

  it('passes a clean payload of opaque references and plain JSON scalars', () => {
    expect(() =>
      assertNoForbiddenShapes({
        id: 'lhref_trk_0123456789abcdef',
        name: 'Drums',
        notes: [{ pitch: 36, startTime: 0, duration: 0.25, velocity: 100 }],
        nested: { clipId: 'lhref_clip_0123456789abcdef', count: 4 },
        list: ['lhref_trk_0123456789abcdef', 'lhref_trk_fedcba9876543210'],
        nothing: null,
      }),
    ).not.toThrow();
  });
});
