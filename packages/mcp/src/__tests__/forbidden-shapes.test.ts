/**
 * Negative control for `assertNoForbiddenShapes` (the harness scanner).
 *
 * The scanner backs the first-class claim that no `Handle`/`bigint` ever crosses
 * the MCP wire (02_BRIDGE_SPEC §3, §8). Every integration test feeds it CLEAN
 * payloads, so without a negative control a silent no-op bug in the walker would
 * let every "no forbidden shape" assertion pass vacuously. These tests plant the
 * forbidden shapes and assert the scanner THROWS, proving it actually inspects the
 * graph; and confirm it passes a clean string-id payload.
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

  it('throws on a numeric id (host id) where a string path id is required', () => {
    expect(() => assertNoForbiddenShapes({ id: 42, name: 'Drums' })).toThrow(/numeric id/i);
  });

  it('passes a clean payload of string path ids and plain JSON scalars', () => {
    expect(() =>
      assertNoForbiddenShapes({
        id: 'track:0',
        name: 'Drums',
        notes: [{ pitch: 36, startTime: 0, duration: 0.25, velocity: 100 }],
        nested: { clipId: 'track:0/clipslot:0/clip', count: 4 },
        list: ['track:0', 'track:1'],
        nothing: null,
      }),
    ).not.toThrow();
  });
});
