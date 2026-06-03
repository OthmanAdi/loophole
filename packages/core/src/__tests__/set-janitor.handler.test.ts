/**
 * Ring 2 tests for the Set Janitor command handler against {@link FakeLiveBridge}
 * (03_EXTENSIONS_SPEC §5(f)). Seed a messy Set, run the handler with a chosen subset,
 * and pin the headline claims: chosen renames/recolors land, UNCHOSEN deletes do NOT
 * fire, chosen deletes DO, and the whole sweep is exactly ONE transaction (one undo).
 *
 * The mixed sync-setter (rename/recolor) + async-delete transaction shape is exactly
 * what this ring exists to verify, with no Ableton install.
 */

import { describe, expect, it } from 'vitest';

import { FakeLiveBridge } from '../fake-live-bridge.js';
import { runSetJanitor } from '../handlers/set-janitor.js';
import { detectIssues, planFixes } from '../transforms/janitor.js';
import { sessionClipId, trackId } from '../ids.js';
import type { ClipInfo, SetClipDTO, SetDTO, SetTrackDTO, TrackInfo } from '../dtos.js';

// The issue ids the handler computes for FakeLiveBridge.seededMessySet(). Derived the
// same way detectIssues derives them (`<kind>:<targetPathId>`), against the known
// fixture layout: Bass (track 0) has an off-palette Bassline at slot 0; the
// placeholder track "1-MIDI" (track 1) holds the placeholder clip "Audio 3" at slot
// 0; the "Empty" audio track (track 2) is clip- and device-free.
const ISSUE = {
  emptyTrack: `emptyTrack:${trackId(2)}`,
  renameTrack: `placeholderName:${trackId(1)}`,
  renameClip: `placeholderName:${sessionClipId(1, 0)}`,
  recolorClip: `offPaletteColor:${sessionClipId(0, 0)}`,
  // Bass (track 0) slot 1 is the "Loop" clip with endMarker 6 > loopEnd 4.
  loopOverrun: `loopOverrun:${sessionClipId(0, 1)}`,
} as const;

/**
 * Rebuild the same SetDTO the handler reads, so a test can assert exactly which
 * issues the through-the-bridge path sees (it mirrors the handler's readSet).
 */
function readSetViaBridge(bridge: FakeLiveBridge): SetDTO {
  const toClip = (clip: ClipInfo): SetClipDTO => {
    const base = {
      id: clip.id,
      name: clip.name,
      color: clip.color,
      looping: clip.looping,
      loopStart: clip.loopStart,
      loopEnd: clip.loopEnd,
      endMarker: clip.endMarker,
    };
    return clip.slotId === undefined ? base : { ...base, slotId: clip.slotId };
  };
  const toTrack = (track: TrackInfo): SetTrackDTO => ({
    id: track.id,
    kind: track.kind,
    name: track.name,
    deviceCount: track.deviceCount,
    clips: bridge
      .listClips(track.id)
      .filter((c) => c.kind !== 'empty')
      .map(toClip),
  });
  return { tracks: bridge.listTracks().map(toTrack) };
}

describe('runSetJanitor: detects the seeded mess through the bridge', () => {
  it('finds the empty track, both placeholder names, and the off-palette color', () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const ids = detectIssues(readSetViaBridge(bridge)).map((i) => i.id);
    expect(ids).toContain(ISSUE.emptyTrack);
    expect(ids).toContain(ISSUE.renameTrack);
    expect(ids).toContain(ISSUE.renameClip);
    expect(ids).toContain(ISSUE.recolorClip);
  });

  it('surfaces the planted loop-overrun through the bridge (endMarker now on ClipInfo)', () => {
    // The fixture's Bass slot-1 clip has endMarker 6 > loopEnd 4. listClips now exposes
    // endMarker, so the through-the-bridge path detects the overrun (the stage-3
    // resolution of the former shared-surface gap).
    const bridge = FakeLiveBridge.seededMessySet();
    const overruns = detectIssues(readSetViaBridge(bridge)).filter((i) => i.kind === 'loopOverrun');
    expect(overruns.map((i) => i.id)).toEqual([ISSUE.loopOverrun]);
    expect(overruns[0]?.target).toBe(sessionClipId(0, 1));
  });
});

describe('runSetJanitor: applies a chosen subset in one undo', () => {
  it('renames the chosen track + clip and recolors the chosen clip; one transaction', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    expect(bridge.transactionCount).toBe(0);

    const result = await runSetJanitor(bridge, {
      chosenIssueIds: [ISSUE.renameTrack, ISSUE.renameClip, ISSUE.recolorClip],
    });

    expect(result.applied).toBe(3);
    // Exactly ONE undo step for the whole sweep.
    expect(bridge.transactionCount).toBe(1);

    // Track "1-MIDI" (index 1) renamed to the path-derived, non-placeholder "Track 2".
    expect(bridge.listTracks()[1]?.name).toBe('Track 2');
    // Clip "Audio 3" (slot 0) renamed to the path-derived "Clip 1".
    expect(bridge.listClips(trackId(1))[0]?.name).toBe('Clip 1');
    // Off-palette Bassline (12345) recolored to an on-palette value (no longer 12345).
    const bassline = bridge.listClips(trackId(0))[0];
    expect(bassline?.color).not.toBe(12345);
  });

  it('does NOT delete the empty track when its delete issue is unchosen', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    expect(bridge.listTracks()).toHaveLength(3);

    // Choose only the renames/recolor, NOT the empty-track delete.
    await runSetJanitor(bridge, {
      chosenIssueIds: [ISSUE.renameTrack, ISSUE.recolorClip],
    });

    // The empty "Empty" track is still present: the unchosen delete did not fire.
    expect(bridge.listTracks()).toHaveLength(3);
    expect(bridge.listTracks()[2]?.name).toBe('Empty');
  });

  it('DOES delete the empty track when its delete issue is chosen', async () => {
    const bridge = FakeLiveBridge.seededMessySet();

    await runSetJanitor(bridge, { chosenIssueIds: [ISSUE.emptyTrack] });

    const names = bridge.listTracks().map((t) => t.name);
    expect(names).toEqual(['Bass', '1-MIDI']);
  });

  it('a mixed rename + recolor + delete sweep is still exactly ONE transaction', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    expect(bridge.transactionCount).toBe(0);

    const result = await runSetJanitor(bridge, {
      chosenIssueIds: [ISSUE.renameTrack, ISSUE.recolorClip, ISSUE.emptyTrack],
    });

    expect(result.applied).toBe(3);
    expect(bridge.transactionCount).toBe(1);
    // Delete landed (Empty gone), rename landed (track 1 -> "Track 2"), recolor landed.
    expect(bridge.listTracks().map((t) => t.name)).toEqual(['Bass', 'Track 2']);
    expect(bridge.listClips(trackId(0))[0]?.color).not.toBe(12345);
  });

  it('applies nothing and opens no transaction when no issue is chosen', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const result = await runSetJanitor(bridge, { chosenIssueIds: [] });
    expect(result.applied).toBe(0);
    expect(bridge.transactionCount).toBe(0);
  });

  it('planFixes over the chosen subset yields one rename, one recolor, one delete', () => {
    // A direct transform check on the same chosen subset the handler uses, so the
    // handler's "deletes only for chosen delete-fixes" is grounded in the plan too.
    const bridge = FakeLiveBridge.seededMessySet();
    const issues = detectIssues(readSetViaBridge(bridge));
    const fixes = planFixes(issues, [ISSUE.renameTrack, ISSUE.recolorClip, ISSUE.emptyTrack]);
    expect(fixes.map((f) => f.kind).sort()).toEqual(['deleteTrack', 'recolor', 'rename']);
    // The delete fix carries no value (marked distinctly).
    const del = fixes.find((f) => f.kind === 'deleteTrack');
    expect(del?.name).toBeUndefined();
    expect(del?.color).toBeUndefined();
  });
});
