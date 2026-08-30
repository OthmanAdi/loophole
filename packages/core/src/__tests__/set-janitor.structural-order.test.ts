/** Regression coverage for Set Janitor's position-sensitive structural ordering. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Fix } from '../dtos.js';
import { FakeLiveBridge } from '../fake-live-bridge.js';
import { arrangementClipId, trackId } from '../ids.js';

const planned = vi.hoisted(() => ({ fixes: [] as Fix[] }));

vi.mock('../transforms/janitor.js', () => ({
  detectIssues: () => [],
  planFixes: () => planned.fixes,
}));

import { runSetJanitor } from '../handlers/set-janitor.js';

function arrangementNames(bridge: FakeLiveBridge, track: number): string[] {
  return bridge
    .listClips(trackId(track))
    .filter((clip) => clip.location === 'arrangement')
    .map((clip) => clip.name);
}

async function bridgeWithFourBassArrangementClips(): Promise<FakeLiveBridge> {
  const bridge = FakeLiveBridge.seeded();
  const bass = trackId(1);
  const created = await Promise.all([
    bridge.createArrangementMidiClip(bass, 8, 4),
    bridge.createArrangementMidiClip(bass, 12, 4),
    bridge.createArrangementMidiClip(bass, 16, 4),
  ]);
  await Promise.all(
    created.map((clip, index) => bridge.setClipProps(clip.id, { name: `Added ${index + 1}` })),
  );
  return bridge;
}

describe('runSetJanitor: deterministic structural deletion order', () => {
  beforeEach(() => {
    planned.fixes = [];
  });

  it('deletes adjacent Arrangement clips from highest to lowest index', async () => {
    const bridge = await bridgeWithFourBassArrangementClips();
    expect(arrangementNames(bridge, 1)).toEqual(['Bass (arr)', 'Added 1', 'Added 2', 'Added 3']);
    planned.fixes = [
      { kind: 'deleteClip', target: arrangementClipId(1, 1) },
      { kind: 'deleteClip', target: arrangementClipId(1, 2) },
    ];

    await expect(runSetJanitor(bridge, { chosenIssueIds: ['mock'] })).resolves.toEqual({
      applied: 2,
    });

    expect(arrangementNames(bridge, 1)).toEqual(['Bass (arr)', 'Added 3']);
  });

  it('deletes non-adjacent Arrangement clips without retargeting a shifted clip', async () => {
    const bridge = await bridgeWithFourBassArrangementClips();
    planned.fixes = [
      { kind: 'deleteClip', target: arrangementClipId(1, 0) },
      { kind: 'deleteClip', target: arrangementClipId(1, 2) },
    ];

    await runSetJanitor(bridge, { chosenIssueIds: ['mock'] });

    expect(arrangementNames(bridge, 1)).toEqual(['Added 1', 'Added 3']);
  });

  it('deletes adjacent tracks from highest to lowest original index', async () => {
    const bridge = FakeLiveBridge.seeded();
    planned.fixes = [
      { kind: 'deleteTrack', target: trackId(0) },
      { kind: 'deleteTrack', target: trackId(1) },
    ];

    await runSetJanitor(bridge, { chosenIssueIds: ['mock'] });

    // Descending deletion removes the original Drums and Bass tracks. Ascending
    // deletion would retarget index 1 after the first splice and incorrectly keep Bass.
    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Vocals']);
  });

  it('finishes clip deletes before deleting tracks from highest to lowest index', async () => {
    const bridge = await bridgeWithFourBassArrangementClips();
    const undoStepsBefore = bridge.transactionCount;
    planned.fixes = [
      { kind: 'deleteTrack', target: trackId(0) },
      { kind: 'deleteClip', target: arrangementClipId(1, 1) },
      { kind: 'deleteTrack', target: trackId(2) },
      { kind: 'deleteClip', target: arrangementClipId(1, 3) },
    ];

    await runSetJanitor(bridge, { chosenIssueIds: ['mock'] });

    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Bass']);
    expect(arrangementNames(bridge, 0)).toEqual(['Bass (arr)', 'Added 2']);
    expect(bridge.transactionCount - undoStepsBefore).toBe(4);
  });

  it('exposes a stale delete and stops before later structural operations', async () => {
    const bridge = await bridgeWithFourBassArrangementClips();
    const undoStepsBefore = bridge.transactionCount;
    planned.fixes = [
      { kind: 'deleteClip', target: arrangementClipId(1, 3) },
      // The duplicate target becomes stale after the first delete succeeds.
      { kind: 'deleteClip', target: arrangementClipId(1, 3) },
      { kind: 'deleteTrack', target: trackId(2) },
    ];

    await expect(runSetJanitor(bridge, { chosenIssueIds: ['mock'] })).rejects.toMatchObject({
      code: 'STALE_REFERENCE',
    });

    // The first delete is an already-completed undo step. Its duplicate then fails,
    // and the later track delete is never attempted.
    expect(arrangementNames(bridge, 1)).toEqual(['Bass (arr)', 'Added 1', 'Added 2']);
    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Drums', 'Bass', 'Vocals']);
    expect(bridge.transactionCount - undoStepsBefore).toBe(1);
  });
});
