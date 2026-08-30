/** Regression coverage for identity-safe Set Janitor structural mutations. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isPlayableClip, type Fix } from '../dtos.js';
import { FakeLiveBridge } from '../fake-live-bridge.js';
import type { ClipId, TrackId } from '../ids.js';

const planned = vi.hoisted(() => ({ fixes: [] as Fix[] }));

vi.mock('../transforms/janitor.js', () => ({
  detectIssues: () => [],
  planFixes: () => planned.fixes,
}));

import { runSetJanitor } from '../handlers/set-janitor.js';

function trackAt(bridge: FakeLiveBridge, index: number): TrackId {
  const track = bridge.listTracks()[index];
  if (track === undefined) throw new Error(`Missing fixture track ordinal ${String(index)}`);
  return track.id;
}

function arrangementClips(bridge: FakeLiveBridge, track: TrackId) {
  return bridge
    .listClips(track)
    .filter(isPlayableClip)
    .filter((clip) => clip.location === 'arrangement');
}

function arrangementNames(bridge: FakeLiveBridge, track: TrackId): string[] {
  return arrangementClips(bridge, track).map((clip) => clip.name);
}

async function bridgeWithFourBassArrangementClips(): Promise<{
  bridge: FakeLiveBridge;
  bass: TrackId;
  clips: readonly ClipId[];
}> {
  const bridge = FakeLiveBridge.seeded();
  const bass = trackAt(bridge, 1);
  const existing = arrangementClips(bridge, bass)[0];
  if (existing === undefined) throw new Error('Missing existing Bass Arrangement clip');
  const clips: ClipId[] = [existing.id];

  for (const [index, startBeat] of [8, 12, 16].entries()) {
    const created = await bridge.createArrangementMidiClip(bass, startBeat, 4);
    if (!isPlayableClip(created)) throw new Error('Arrangement creation returned an empty slot');
    await bridge.setClipProps(created.id, { name: `Added ${String(index + 1)}` });
    clips.push(created.id);
  }

  return { bridge, bass, clips };
}

describe('runSetJanitor: opaque structural targets survive sibling mutation', () => {
  beforeEach(() => {
    planned.fixes = [];
  });

  it('deletes adjacent Arrangement clips by their returned identities', async () => {
    const { bridge, bass, clips } = await bridgeWithFourBassArrangementClips();
    const deleteClip = vi.spyOn(bridge, 'deleteClip');
    const firstSelected = clips[1];
    const secondSelected = clips[2];
    if (firstSelected === undefined || secondSelected === undefined) {
      throw new Error('Missing adjacent fixture clips');
    }
    planned.fixes = [
      { kind: 'deleteClip', target: firstSelected, targetKind: 'clip' },
      { kind: 'deleteClip', target: secondSelected, targetKind: 'clip' },
    ];

    await expect(runSetJanitor(bridge, { chosenIssueIds: ['selected'] })).resolves.toEqual({
      applied: 2,
    });

    expect(deleteClip.mock.calls.map(([target]) => target)).toEqual([
      secondSelected,
      firstSelected,
    ]);
    expect(arrangementNames(bridge, bass)).toEqual(['Bass (arr)', 'Added 3']);
  });

  it('deletes non-adjacent Arrangement clips without retargeting a survivor', async () => {
    const { bridge, bass, clips } = await bridgeWithFourBassArrangementClips();
    const deleteClip = vi.spyOn(bridge, 'deleteClip');
    const first = clips[0];
    const third = clips[2];
    if (first === undefined || third === undefined) throw new Error('Missing fixture clips');
    planned.fixes = [
      { kind: 'deleteClip', target: first, targetKind: 'clip' },
      { kind: 'deleteClip', target: third, targetKind: 'clip' },
    ];

    await runSetJanitor(bridge, { chosenIssueIds: ['selected'] });

    expect(deleteClip.mock.calls.map(([target]) => target)).toEqual([third, first]);
    expect(arrangementNames(bridge, bass)).toEqual(['Added 1', 'Added 3']);
  });

  it('deletes adjacent tracks by their returned identities', async () => {
    const bridge = FakeLiveBridge.seeded();
    const deleteTrack = vi.spyOn(bridge, 'deleteTrack');
    const drums = trackAt(bridge, 0);
    const bass = trackAt(bridge, 1);
    planned.fixes = [
      { kind: 'deleteTrack', target: drums, targetKind: 'track' },
      { kind: 'deleteTrack', target: bass, targetKind: 'track' },
    ];

    await runSetJanitor(bridge, { chosenIssueIds: ['selected'] });

    expect(deleteTrack.mock.calls.map(([target]) => target)).toEqual([bass, drums]);
    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Vocals']);
  });

  it('orders clip deletes by track ordinal before applying per-track descending order', async () => {
    const bridge = FakeLiveBridge.seeded();
    const deleteClip = vi.spyOn(bridge, 'deleteClip');
    const drums = trackAt(bridge, 0);
    const bass = trackAt(bridge, 1);
    const drumsClip = bridge.listClips(drums).find(isPlayableClip);
    const bassArrangement = arrangementClips(bridge, bass)[0];
    if (drumsClip === undefined || bassArrangement === undefined) {
      throw new Error('Missing cross-track fixture clips');
    }
    // Deliberately submit the later track first. Snapshot order must win.
    planned.fixes = [
      { kind: 'deleteClip', target: bassArrangement.id, targetKind: 'clip' },
      { kind: 'deleteClip', target: drumsClip.id, targetKind: 'clip' },
    ];

    await runSetJanitor(bridge, { chosenIssueIds: ['selected'] });

    expect(deleteClip.mock.calls.map(([target]) => target)).toEqual([
      drumsClip.id,
      bassArrangement.id,
    ]);
  });

  it('finishes selected clip deletes before mixed track deletes without identity drift', async () => {
    const { bridge, bass, clips } = await bridgeWithFourBassArrangementClips();
    const deleteClip = vi.spyOn(bridge, 'deleteClip');
    const deleteTrack = vi.spyOn(bridge, 'deleteTrack');
    const drums = trackAt(bridge, 0);
    const vocals = trackAt(bridge, 2);
    const addedOne = clips[1];
    const addedThree = clips[3];
    if (addedOne === undefined || addedThree === undefined)
      throw new Error('Missing fixture clips');
    const undoStepsBefore = bridge.transactionCount;
    planned.fixes = [
      { kind: 'deleteTrack', target: drums, targetKind: 'track' },
      { kind: 'deleteClip', target: addedOne, targetKind: 'clip' },
      { kind: 'deleteTrack', target: vocals, targetKind: 'track' },
      { kind: 'deleteClip', target: addedThree, targetKind: 'clip' },
    ];

    await runSetJanitor(bridge, { chosenIssueIds: ['selected'] });

    expect(deleteClip.mock.calls.map(([target]) => target)).toEqual([addedThree, addedOne]);
    expect(deleteTrack.mock.calls.map(([target]) => target)).toEqual([vocals, drums]);
    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Bass']);
    expect(arrangementNames(bridge, bass)).toEqual(['Bass (arr)', 'Added 2']);
    expect(bridge.transactionCount - undoStepsBefore).toBe(4);
  });

  it('exposes a stale duplicate and stops before later structural operations', async () => {
    const { bridge, bass, clips } = await bridgeWithFourBassArrangementClips();
    const deleteClip = vi.spyOn(bridge, 'deleteClip');
    const deleteTrack = vi.spyOn(bridge, 'deleteTrack');
    const vocals = trackAt(bridge, 2);
    const addedThree = clips[3];
    if (addedThree === undefined) throw new Error('Missing fixture clip');
    const undoStepsBefore = bridge.transactionCount;
    planned.fixes = [
      { kind: 'deleteClip', target: addedThree, targetKind: 'clip' },
      { kind: 'deleteClip', target: addedThree, targetKind: 'clip' },
      { kind: 'deleteTrack', target: vocals, targetKind: 'track' },
    ];

    await expect(runSetJanitor(bridge, { chosenIssueIds: ['selected'] })).rejects.toMatchObject({
      code: 'STALE_REFERENCE',
    });

    expect(deleteClip.mock.calls.map(([target]) => target)).toEqual([addedThree, addedThree]);
    expect(deleteTrack).not.toHaveBeenCalled();
    expect(arrangementNames(bridge, bass)).toEqual(['Bass (arr)', 'Added 1', 'Added 2']);
    expect(bridge.listTracks().map((track) => track.name)).toEqual(['Drums', 'Bass', 'Vocals']);
    expect(bridge.transactionCount - undoStepsBefore).toBe(1);
  });
});
