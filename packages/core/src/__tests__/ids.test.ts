/**
 * Ring 1 unit tests for the stable path-id scheme: the typed builders, parse/build
 * round-trips, the load-bearing index validation, and the leaf helpers. No bridge,
 * no I/O.
 */

import { describe, expect, it } from 'vitest';

import {
  arrangementClipId,
  buildPath,
  clipSlotId,
  cuePointId,
  deviceId,
  leafKind,
  leafSegment,
  makePathId,
  mixerVolumeParamId,
  paramId,
  parsePath,
  PathIdParseError,
  returnTrackId,
  sceneId,
  sessionClipId,
  trackId,
  tryParsePath,
} from '../ids.js';

describe('typed builders produce the documented id strings', () => {
  it('builds the whole id vocabulary', () => {
    expect(trackId(2)).toBe('track:2');
    expect(returnTrackId(0)).toBe('returntrack:0');
    expect(clipSlotId(2, 4)).toBe('track:2/clipslot:4');
    expect(sessionClipId(2, 4)).toBe('track:2/clipslot:4/clip');
    expect(arrangementClipId(2, 0)).toBe('track:2/clip:0');
    expect(sceneId(1)).toBe('scene:1');
    expect(cuePointId(0)).toBe('cuepoint:0');
    expect(deviceId(2, 0)).toBe('track:2/device:0');
    expect(paramId(2, 0, 3)).toBe('track:2/device:0/param:3');
    expect(mixerVolumeParamId(2)).toBe('track:2/mixer/volume');
  });

  it('distinguishes a bare terminal clip from an indexed arrangement clip', () => {
    // sessionClipId ends in a bare `clip`; arrangementClipId uses `clip:M`.
    expect(sessionClipId(0, 0).endsWith('/clip')).toBe(true);
    expect(arrangementClipId(0, 0).endsWith('/clip:0')).toBe(true);
  });

  it('parses the bare mixer / volume segments of a mixer volume id', () => {
    expect(parsePath(mixerVolumeParamId(2))).toEqual([
      { kind: 'track', index: 2 },
      { kind: 'mixer' },
      { kind: 'volume' },
    ]);
    // Round-trips through makePathId (valid by construction).
    expect(() => makePathId('track:0/mixer/volume')).not.toThrow();
  });
});

describe('parsePath', () => {
  it('round-trips a built id back to typed segments', () => {
    const segments = parsePath(paramId(2, 0, 3));
    expect(segments).toEqual([
      { kind: 'track', index: 2 },
      { kind: 'device', index: 0 },
      { kind: 'param', index: 3 },
    ]);
  });

  it('parses a bare terminal clip segment without an index', () => {
    const segments = parsePath(sessionClipId(1, 1));
    expect(segments[segments.length - 1]).toEqual({ kind: 'clip' });
  });

  it('rejects malformed segments and empty input', () => {
    expect(() => parsePath('')).toThrow(PathIdParseError);
    expect(() => parsePath('bogus')).toThrow(PathIdParseError);
    expect(() => parsePath('track:')).toThrow(PathIdParseError);
    expect(() => parsePath(':2')).toThrow(PathIdParseError);
    expect(() => parsePath('track:2/')).toThrow(PathIdParseError);
  });

  it('rejects non-canonical integer indices', () => {
    // Leading zero, sign, decimal, hex, whitespace are all rejected by the regex.
    expect(() => parsePath('track:01')).toThrow();
    expect(() => parsePath('track:-1')).toThrow();
    expect(() => parsePath('track:1.5')).toThrow();
    expect(() => parsePath('track:0x1')).toThrow();
    expect(() => parsePath('track: 2')).toThrow();
  });

  it('accepts a canonical zero index', () => {
    expect(() => parsePath('track:0')).not.toThrow();
  });

  it('rejects an unknown indexed kind', () => {
    expect(() => parsePath('boguskind:0')).toThrow();
  });
});

describe('buildPath', () => {
  it('throws on an empty segment list', () => {
    expect(() => buildPath([])).toThrow(PathIdParseError);
  });

  it('throws on a negative or non-integer index', () => {
    expect(() => buildPath([{ kind: 'track', index: -1 }])).toThrow(PathIdParseError);
    expect(() => buildPath([{ kind: 'track', index: 1.5 }])).toThrow(PathIdParseError);
  });

  it('renders a bare clip segment without an index', () => {
    expect(buildPath([{ kind: 'track', index: 0 }, { kind: 'clip' }])).toBe('track:0/clip');
  });
});

describe('makePathId / tryParsePath', () => {
  it('makePathId validates then brands', () => {
    expect(makePathId('track:2')).toBe('track:2');
    expect(() => makePathId('nope')).toThrow();
  });

  it('tryParsePath returns null instead of throwing', () => {
    expect(tryParsePath('nope')).toBeNull();
    expect(tryParsePath('track:2')).not.toBeNull();
  });
});

describe('leafSegment / leafKind', () => {
  it('returns the last segment and its kind', () => {
    expect(leafKind(paramId(2, 0, 3))).toBe('param');
    expect(leafSegment(sessionClipId(0, 0))).toEqual({ kind: 'clip' });
    expect(leafKind(trackId(5))).toBe('track');
  });
});
