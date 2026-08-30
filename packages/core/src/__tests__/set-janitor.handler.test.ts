/**
 * Set Janitor handler tests against the opaque-reference FakeLiveBridge.
 *
 * Issue selections are discovered from the fixture at runtime. No test reconstructs
 * a target from an array position, which is the contract these tests prove.
 */

import { describe, expect, it } from 'vitest';

import {
  isPlayableClip,
  type ClipInfo,
  type Issue,
  type SetClipDTO,
  type SetDTO,
  type SetTrackDTO,
  type TrackInfo,
} from '../dtos.js';
import { FakeLiveBridge } from '../fake-live-bridge.js';
import { runSetJanitor } from '../handlers/set-janitor.js';
import { detectIssues, planFixes } from '../transforms/janitor.js';

function readSetViaBridge(bridge: FakeLiveBridge): SetDTO {
  const toClip = (clip: ClipInfo): SetClipDTO => {
    if (!isPlayableClip(clip)) throw new Error('empty slot leaked into Janitor input');
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
    clips: bridge.listClips(track.id).filter(isPlayableClip).map(toClip),
  });
  return { tracks: bridge.listTracks().map(toTrack) };
}

function detectedIssues(bridge: FakeLiveBridge): readonly Issue[] {
  return detectIssues(readSetViaBridge(bridge));
}

function issueByKind(
  bridge: FakeLiveBridge,
  kind: Issue['kind'],
  targetKind?: Issue['targetKind'],
): Issue {
  const issue = detectedIssues(bridge).find(
    (candidate) =>
      candidate.kind === kind && (targetKind === undefined || candidate.targetKind === targetKind),
  );
  if (issue === undefined) throw new Error(`Missing ${kind}/${targetKind ?? 'any'} fixture issue`);
  return issue;
}

describe('runSetJanitor: detects the seeded mess through opaque bridge references', () => {
  it('finds the empty track, both placeholder names, and the off-palette color', () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const issues = detectedIssues(bridge);

    expect(issues.filter((issue) => issue.kind === 'emptyTrack')).toHaveLength(1);
    expect(issues.filter((issue) => issue.kind === 'placeholderName')).toHaveLength(2);
    expect(issues.filter((issue) => issue.kind === 'offPaletteColor')).toHaveLength(1);
    expect(issues.find((issue) => issue.kind === 'emptyTrack')?.targetKind).toBe('track');
    expect(
      issues
        .filter((issue) => issue.kind === 'placeholderName')
        .map((issue) => issue.targetKind)
        .sort(),
    ).toEqual(['clip', 'track']);
  });

  it('surfaces the planted loop-overrun with the exact clip reference returned by the fake', () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const bass = bridge.listTracks().find((track) => track.name === 'Bass');
    if (bass === undefined) throw new Error('Missing Bass fixture track');
    const loop = bridge
      .listClips(bass.id)
      .filter(isPlayableClip)
      .find((clip) => clip.name === 'Loop');
    if (loop === undefined) throw new Error('Missing Loop fixture clip');

    const overruns = detectedIssues(bridge).filter((issue) => issue.kind === 'loopOverrun');
    expect(overruns).toHaveLength(1);
    expect(overruns[0]?.target).toBe(loop.id);
    expect(overruns[0]?.targetKind).toBe('clip');
  });
});

describe('runSetJanitor: applies chosen opaque targets with explicit undo phases', () => {
  it('renames the chosen track and clip and recolors the chosen clip in one value transaction', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const tracks = bridge.listTracks();
    const bass = tracks.find((track) => track.name === 'Bass');
    const placeholder = tracks.find((track) => track.name === '1-MIDI');
    if (bass === undefined || placeholder === undefined) throw new Error('Missing Janitor fixture');
    const placeholderIssues = detectedIssues(bridge).filter(
      (issue) => issue.kind === 'placeholderName',
    );
    const recolor = issueByKind(bridge, 'offPaletteColor', 'clip');

    const result = await runSetJanitor(bridge, {
      chosenIssueIds: [...placeholderIssues.map((issue) => issue.id), recolor.id],
    });

    expect(result.applied).toBe(3);
    expect(bridge.transactionCount).toBe(1);
    expect(bridge.listTracks().find((track) => track.id === placeholder.id)?.name).toBe('Track 2');
    expect(bridge.listClips(placeholder.id).filter(isPlayableClip)[0]?.name).toBe('Clip 1');
    expect(bridge.listClips(bass.id).filter(isPlayableClip)[0]?.color).not.toBe(12345);
  });

  it('does not delete the empty track when its delete issue is unchosen', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const rename = issueByKind(bridge, 'placeholderName', 'track');
    const recolor = issueByKind(bridge, 'offPaletteColor', 'clip');

    await runSetJanitor(bridge, { chosenIssueIds: [rename.id, recolor.id] });

    expect(bridge.listTracks()).toHaveLength(3);
    expect(bridge.listTracks().some((track) => track.name === 'Empty')).toBe(true);
  });

  it('deletes the empty track when its delete issue is chosen', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const empty = issueByKind(bridge, 'emptyTrack', 'track');

    await runSetJanitor(bridge, { chosenIssueIds: [empty.id] });

    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Bass', '1-MIDI']);
  });

  it('groups value edits, then applies the structural delete as its own undo step', async () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const rename = issueByKind(bridge, 'placeholderName', 'track');
    const recolor = issueByKind(bridge, 'offPaletteColor', 'clip');
    const empty = issueByKind(bridge, 'emptyTrack', 'track');
    const bass = bridge.listTracks().find((track) => track.name === 'Bass');
    if (bass === undefined) throw new Error('Missing Bass fixture track');

    const result = await runSetJanitor(bridge, {
      chosenIssueIds: [rename.id, recolor.id, empty.id],
    });

    expect(result.applied).toBe(3);
    expect(bridge.transactionCount).toBe(2);
    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Bass', 'Track 2']);
    expect(bridge.listClips(bass.id).filter(isPlayableClip)[0]?.color).not.toBe(12345);
  });

  it('applies nothing and opens no transaction when no issue is chosen', async () => {
    const bridge = FakeLiveBridge.seededMessySet();

    await expect(runSetJanitor(bridge, { chosenIssueIds: [] })).resolves.toEqual({ applied: 0 });
    expect(bridge.transactionCount).toBe(0);
  });

  it('plans one typed rename, recolor, and delete for the chosen subset', () => {
    const bridge = FakeLiveBridge.seededMessySet();
    const issues = detectedIssues(bridge);
    const rename = issues.find(
      (issue) => issue.kind === 'placeholderName' && issue.targetKind === 'track',
    );
    const recolor = issues.find((issue) => issue.kind === 'offPaletteColor');
    const empty = issues.find((issue) => issue.kind === 'emptyTrack');
    if (rename === undefined || recolor === undefined || empty === undefined) {
      throw new Error('Missing selected Janitor issues');
    }

    const fixes = planFixes(issues, [rename.id, recolor.id, empty.id]);

    expect(fixes.map((fix) => fix.kind).sort()).toEqual(['deleteTrack', 'recolor', 'rename']);
    expect(fixes.map((fix) => fix.targetKind).sort()).toEqual(['clip', 'track', 'track']);
    const deletion = fixes.find((fix) => fix.kind === 'deleteTrack');
    expect(deletion?.name).toBeUndefined();
    expect(deletion?.color).toBeUndefined();
  });
});
