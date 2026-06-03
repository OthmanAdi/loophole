/**
 * Ring 1 unit tests for the Set Janitor pure transforms (03_EXTENSIONS_SPEC §5(f)).
 * No bridge, no I/O: hand-built {@link SetDTO}s in, exact {@link Issue} / {@link Fix}
 * arrays out. This is the bulk of the Set Janitor assertions.
 */

import { describe, expect, it } from 'vitest';

import type { SetClipDTO, SetDTO, SetTrackDTO } from '../dtos.js';
import { sessionClipId, trackId } from '../ids.js';
import { DEFAULT_CLIP_PALETTE, detectIssues, planFixes } from '../transforms/janitor.js';

// --- small builders so each test states only the fields its rule cares about ---

function clip(overrides: Partial<SetClipDTO> & Pick<SetClipDTO, 'id'>): SetClipDTO {
  return {
    name: 'Real Clip Name',
    color: 255, // on-palette by default
    looping: true,
    loopStart: 0,
    loopEnd: 4,
    endMarker: 4, // == loopEnd: no overrun by default
    ...overrides,
  };
}

function track(overrides: Partial<SetTrackDTO> & Pick<SetTrackDTO, 'id'>): SetTrackDTO {
  return {
    kind: 'midi',
    name: 'Bass',
    deviceCount: 1,
    clips: [],
    ...overrides,
  };
}

function set(tracks: readonly SetTrackDTO[]): SetDTO {
  return { tracks };
}

/** The rename name a fix list assigns to a given target (for idempotence checks). */
function nameFor(
  fixes: readonly { kind: string; target: string; name?: string }[],
  target: string,
): string {
  return fixes.find((f) => f.kind === 'rename' && f.target === target)?.name ?? '';
}

describe('detectIssues: empty tracks', () => {
  it('flags a track with no clips and no devices', () => {
    const result = detectIssues(set([track({ id: trackId(0), name: 'Empty', deviceCount: 0 })]));
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('emptyTrack');
    expect(result[0]?.target).toBe(trackId(0));
  });

  it('does NOT flag a track that has a device but no clips', () => {
    const result = detectIssues(set([track({ id: trackId(0), name: 'Synth', deviceCount: 2 })]));
    expect(result.some((i) => i.kind === 'emptyTrack')).toBe(false);
  });

  it('does NOT flag a track that has a clip but no devices', () => {
    const t = track({
      id: trackId(0),
      name: 'Drums',
      deviceCount: 0,
      clips: [clip({ id: sessionClipId(0, 0), name: 'Beat' })],
    });
    const result = detectIssues(set([t]));
    expect(result.some((i) => i.kind === 'emptyTrack')).toBe(false);
  });
});

describe('detectIssues: placeholder names', () => {
  it('flags "Audio 3" and "1-MIDI" but not a real name', () => {
    const t = track({
      id: trackId(0),
      name: 'Bass', // real name: not flagged
      clips: [
        clip({ id: sessionClipId(0, 0), name: 'Audio 3' }),
        clip({ id: sessionClipId(0, 1), name: 'Bassline' }), // real name: not flagged
      ],
    });
    const placeholders = detectIssues(set([t])).filter((i) => i.kind === 'placeholderName');
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]?.target).toBe(sessionClipId(0, 0));
  });

  it('flags a "1-MIDI" track name', () => {
    const result = detectIssues(set([track({ id: trackId(0), name: '1-MIDI' })]));
    expect(result.some((i) => i.kind === 'placeholderName' && i.target === trackId(0))).toBe(true);
  });

  it('flags bare "MIDI" / "Audio" and indexed "MIDI 2" / "2-Audio 4"', () => {
    for (const name of ['MIDI', 'Audio', 'MIDI 2', '2-Audio 4']) {
      const result = detectIssues(set([track({ id: trackId(0), name })]));
      expect(result.some((i) => i.kind === 'placeholderName')).toBe(true);
    }
  });

  it('does NOT flag real names that merely contain the type word', () => {
    for (const name of ['Bassline', 'Audrey', 'Lead Audio Take', 'Keys', 'Loop']) {
      const result = detectIssues(set([track({ id: trackId(0), name })]));
      expect(result.some((i) => i.kind === 'placeholderName')).toBe(false);
    }
  });
});

describe('detectIssues: loop overrun', () => {
  it('flags a looping clip whose endMarker overruns loopEnd', () => {
    const t = track({
      id: trackId(0),
      clips: [clip({ id: sessionClipId(0, 0), name: 'Loop', loopEnd: 4, endMarker: 6 })],
    });
    const overruns = detectIssues(set([t])).filter((i) => i.kind === 'loopOverrun');
    expect(overruns).toHaveLength(1);
    expect(overruns[0]?.target).toBe(sessionClipId(0, 0));
  });

  it('does NOT flag a clip whose endMarker equals loopEnd', () => {
    const t = track({
      id: trackId(0),
      clips: [clip({ id: sessionClipId(0, 0), loopEnd: 4, endMarker: 4 })],
    });
    expect(detectIssues(set([t])).some((i) => i.kind === 'loopOverrun')).toBe(false);
  });

  it('does NOT flag an overrun on a non-looping clip', () => {
    const t = track({
      id: trackId(0),
      clips: [clip({ id: sessionClipId(0, 0), looping: false, loopEnd: 4, endMarker: 8 })],
    });
    expect(detectIssues(set([t])).some((i) => i.kind === 'loopOverrun')).toBe(false);
  });
});

describe('detectIssues: off-palette color', () => {
  it('flags a clip whose color is not in the palette', () => {
    const t = track({
      id: trackId(0),
      clips: [clip({ id: sessionClipId(0, 0), name: 'Odd', color: 12345 })],
    });
    const offPalette = detectIssues(set([t])).filter((i) => i.kind === 'offPaletteColor');
    expect(offPalette).toHaveLength(1);
    expect(offPalette[0]?.target).toBe(sessionClipId(0, 0));
  });

  it('does NOT flag a clip whose color is on the palette (incl. 0 = default)', () => {
    const t = track({
      id: trackId(0),
      clips: [
        clip({ id: sessionClipId(0, 0), color: 255 }),
        clip({ id: sessionClipId(0, 1), color: 0 }),
      ],
    });
    expect(detectIssues(set([t])).some((i) => i.kind === 'offPaletteColor')).toBe(false);
  });

  it('honors a caller-supplied palette', () => {
    const t = track({
      id: trackId(0),
      clips: [clip({ id: sessionClipId(0, 0), color: 999 })],
    });
    // 999 is off the default palette but on this custom one: no issue.
    expect(detectIssues(set([t]), new Set([999])).some((i) => i.kind === 'offPaletteColor')).toBe(
      false,
    );
  });
});

describe('detectIssues: a clip can trip several rules at once', () => {
  it('reports placeholder name AND off-palette color AND overrun for one clip', () => {
    const t = track({
      id: trackId(0),
      clips: [
        clip({ id: sessionClipId(0, 0), name: 'Audio 3', color: 12345, loopEnd: 4, endMarker: 6 }),
      ],
    });
    const kinds = detectIssues(set([t])).map((i) => i.kind);
    expect(kinds).toContain('placeholderName');
    expect(kinds).toContain('offPaletteColor');
    expect(kinds).toContain('loopOverrun');
  });

  it('produces stable, distinct ids per (kind, target)', () => {
    const t = track({
      id: trackId(0),
      clips: [clip({ id: sessionClipId(0, 0), name: 'Audio 3', color: 12345 })],
    });
    const ids = detectIssues(set([t])).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // all distinct
    expect(ids).toContain(`offPaletteColor:${sessionClipId(0, 0)}`);
    expect(ids).toContain(`placeholderName:${sessionClipId(0, 0)}`);
  });
});

describe('planFixes: only chosen issues, deletes marked distinctly', () => {
  // A Set with: an empty track (delete), a placeholder-named track (rename), and an
  // off-palette clip (recolor).
  const messy = set([
    track({
      id: trackId(0),
      name: 'Bass',
      clips: [clip({ id: sessionClipId(0, 0), name: 'Odd', color: 12345 })],
    }),
    track({
      id: trackId(1),
      name: '1-MIDI',
      clips: [clip({ id: sessionClipId(1, 0), name: 'X' })],
    }),
    track({ id: trackId(2), name: 'Empty', deviceCount: 0, clips: [] }),
  ]);
  const issues = detectIssues(messy);

  it('returns no fixes when nothing is chosen', () => {
    expect(planFixes(issues, [])).toEqual([]);
  });

  it('returns a fix only for each chosen, fixable issue', () => {
    const rename = issues.find((i) => i.kind === 'placeholderName' && i.target === trackId(1));
    const recolor = issues.find((i) => i.kind === 'offPaletteColor');
    expect(rename).toBeDefined();
    expect(recolor).toBeDefined();

    const fixes = planFixes(issues, [rename!.id, recolor!.id]);
    expect(fixes).toHaveLength(2);
    expect(fixes.map((f) => f.kind).sort()).toEqual(['recolor', 'rename']);
  });

  it('marks a chosen delete (empty track) distinctly: deleteTrack with no value', () => {
    const empty = issues.find((i) => i.kind === 'emptyTrack');
    expect(empty).toBeDefined();
    const fixes = planFixes(issues, [empty!.id]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.kind).toBe('deleteTrack');
    expect(fixes[0]?.target).toBe(trackId(2));
    // Destructive fixes carry no value (what marks them distinct from rename/recolor).
    expect(fixes[0]?.name).toBeUndefined();
    expect(fixes[0]?.color).toBeUndefined();
  });

  it('rename carries a path-derived, non-placeholder name; recolor an on-palette color', () => {
    const rename = issues.find((i) => i.kind === 'placeholderName' && i.target === trackId(1))!;
    const recolor = issues.find((i) => i.kind === 'offPaletteColor')!;
    const fixes = planFixes(issues, [rename.id, recolor.id]);

    const renameFix = fixes.find((f) => f.kind === 'rename');
    const recolorFix = fixes.find((f) => f.kind === 'recolor');
    // The "1-MIDI" track (index 1) renames to the 1-based "Track 2", derived from the
    // path, NOT from the old name.
    expect(renameFix?.name).toBe('Track 2');
    // The recolor steers to the first non-default palette entry.
    expect(recolorFix?.color).not.toBe(12345);
    expect(DEFAULT_CLIP_PALETTE.has(recolorFix?.color ?? -1)).toBe(true);
  });

  it('the rename target is itself NOT a placeholder (the fix is idempotent)', () => {
    // A placeholder track AND a placeholder clip, so both rename values can be fed
    // back through detect: re-detecting must not re-flag the renamed objects, because
    // "Track N" / "Clip N" are outside the placeholder pattern.
    const placeholders = set([
      track({
        id: trackId(1),
        name: '1-MIDI',
        clips: [clip({ id: sessionClipId(1, 0), name: 'Audio 3' })],
      }),
    ]);
    const issuesP = detectIssues(placeholders);
    const chosen = issuesP.filter((i) => i.kind === 'placeholderName').map((i) => i.id);
    const fixes = planFixes(issuesP, chosen);
    expect(fixes).toHaveLength(2);

    // Apply each rename to a fresh single-object Set and re-detect: no placeholder.
    expect(
      detectIssues(set([track({ id: trackId(1), name: nameFor(fixes, trackId(1)) })])),
    ).toEqual([]);
    expect(
      detectIssues(
        set([
          track({
            id: trackId(1),
            clips: [clip({ id: sessionClipId(1, 0), name: nameFor(fixes, sessionClipId(1, 0)) })],
          }),
        ]),
      ).some((i) => i.kind === 'placeholderName'),
    ).toBe(false);
  });

  it('drops a chosen loop-overrun issue (no automatic fix exists)', () => {
    const overrunSet = set([
      track({
        id: trackId(0),
        clips: [clip({ id: sessionClipId(0, 0), name: 'Loop', loopEnd: 4, endMarker: 6 })],
      }),
    ]);
    const overrunIssues = detectIssues(overrunSet);
    const overrun = overrunIssues.find((i) => i.kind === 'loopOverrun');
    expect(overrun).toBeDefined();
    // Chosen, but loop-overrun has no auto-fix -> no Fix emitted.
    expect(planFixes(overrunIssues, [overrun!.id])).toEqual([]);
  });

  it('ignores unknown chosen ids', () => {
    expect(planFixes(issues, ['emptyTrack:track:999', 'nonsense'])).toEqual([]);
  });
});
