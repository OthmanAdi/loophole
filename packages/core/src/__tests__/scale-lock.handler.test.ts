/**
 * Ring 2 tests for the Scale Lock (W1) command handler against the
 * {@link FakeLiveBridge}, with no Ableton install. 03_EXTENSIONS_SPEC §1(f).
 *
 * Asserts the read-map-write round-trip (the fake's stored notes equal the expected
 * snapped array), that the whole run is exactly ONE transaction (one undo) across all
 * clips, that the summed movedCount is right, and that a stale clip id and an audio
 * (wrong-type) clip id each surface the typed BridgeError while committing no undo
 * step (the transaction rolls back).
 */

import { describe, expect, it } from 'vitest';

import { isBridgeErrorOfCode } from '../errors.js';
import { FakeLiveBridge } from '../fake-live-bridge.js';
import { runScaleLock } from '../handlers/scale-lock.js';
import { arrangementClipId, sessionClipId } from '../ids.js';
import type { NoteDTO } from '../dtos.js';

/**
 * A sloppy melody over C major: C4 (in scale), C#4 (off), F#4 (off), A4 (in scale).
 * `withOneMidiClip` seeds a C-major Set, so this drives the happy path. Velocities are
 * carried so the round-trip can prove the OTHER note fields survive the snap.
 */
const SLOPPY: readonly NoteDTO[] = [
  { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
  { pitch: 61, startTime: 1, duration: 1, velocity: 90 },
  { pitch: 66, startTime: 2, duration: 1, velocity: 80 },
  { pitch: 69, startTime: 3, duration: 1, velocity: 70 },
];

describe('runScaleLock: read -> snap -> write round-trip vs FakeLiveBridge', () => {
  it('stores the expected nearest-snapped notes and reports the moved count', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip(SLOPPY);
    const result = await runScaleLock(bridge, { clipIds: [bridge.firstClipId], mode: 'nearest' });

    // C#4 (61) -> D4 (62), F#4 (66) -> G4 (67); the two in-scale notes are unchanged.
    expect(result.movedCount).toBe(2);
    const stored = bridge.firstClip().notes;
    expect(stored).toEqual([
      { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
      { pitch: 62, startTime: 1, duration: 1, velocity: 90 },
      { pitch: 67, startTime: 2, duration: 1, velocity: 80 },
      { pitch: 69, startTime: 3, duration: 1, velocity: 70 },
    ]);
  });

  it("snaps 'up' and 'down' too, reading the live scale from the Set", async () => {
    const up = FakeLiveBridge.withOneMidiClip(SLOPPY);
    await runScaleLock(up, { clipIds: [up.firstClipId], mode: 'up' });
    expect(up.firstClip().notes.map((n) => n.pitch)).toEqual([60, 62, 67, 69]);

    const down = FakeLiveBridge.withOneMidiClip(SLOPPY);
    await runScaleLock(down, { clipIds: [down.firstClipId], mode: 'down' });
    // C#4 (61) -> C4 (60), F#4 (66) -> F4 (65).
    expect(down.firstClip().notes.map((n) => n.pitch)).toEqual([60, 60, 65, 69]);
  });

  it('records the whole run as exactly one transaction (one undo)', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip(SLOPPY);
    expect(bridge.transactionCount).toBe(0);
    await runScaleLock(bridge, { clipIds: [bridge.firstClipId], mode: 'nearest' });
    expect(bridge.transactionCount).toBe(1);
  });

  it('groups MULTIPLE clips into one undo and sums movedCount across them', async () => {
    // The default seeded Set: Drums (track 0) and Bass (track 1) each have one
    // Session MIDI clip; its scale is C minor [0,2,3,5,7,8,10].
    const bridge = FakeLiveBridge.seeded();
    const drumsClip = sessionClipId(0, 0); // notes 36,38,36,38 (D2/E2-ish)
    const bassClip = sessionClipId(1, 0); // notes 36,43

    const before0 = bridge.getNotes(drumsClip).map((n) => n.pitch);
    const before1 = bridge.getNotes(bassClip).map((n) => n.pitch);

    const result = await runScaleLock(bridge, {
      clipIds: [drumsClip, bassClip],
      mode: 'nearest',
    });

    // Exactly one undo step for both clips together.
    expect(bridge.transactionCount).toBe(1);

    // movedCount equals the number of pitches that actually changed across both clips.
    const after0 = bridge.getNotes(drumsClip).map((n) => n.pitch);
    const after1 = bridge.getNotes(bassClip).map((n) => n.pitch);
    const changed =
      before0.filter((p, i) => p !== after0[i]).length +
      before1.filter((p, i) => p !== after1[i]).length;
    expect(result.movedCount).toBe(changed);

    // Every resulting pitch is in the C-minor scale (pcs {0,2,3,5,7,8,10}).
    const cMinorPcs = new Set([0, 2, 3, 5, 7, 8, 10]);
    for (const p of [...after0, ...after1]) {
      expect(cMinorPcs.has(((p % 12) + 12) % 12)).toBe(true);
    }
  });

  it('is a no-op (movedCount 0) when every note is already in scale', async () => {
    // All-in-C-major melody.
    const inScale: readonly NoteDTO[] = [
      { pitch: 60, startTime: 0, duration: 1 },
      { pitch: 64, startTime: 1, duration: 1 },
      { pitch: 67, startTime: 2, duration: 1 },
    ];
    const bridge = FakeLiveBridge.withOneMidiClip(inScale);
    const result = await runScaleLock(bridge, { clipIds: [bridge.firstClipId], mode: 'nearest' });
    expect(result.movedCount).toBe(0);
    expect(bridge.firstClip().notes.map((n) => n.pitch)).toEqual([60, 64, 67]);
    // A no-op write is still one queued transaction (one undo).
    expect(bridge.transactionCount).toBe(1);
  });

  it('does nothing and commits no transaction for an empty clip list', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip(SLOPPY);
    const result = await runScaleLock(bridge, { clipIds: [], mode: 'nearest' });
    expect(result.movedCount).toBe(0);
    // No clips selected: no transaction is opened, so the no-op leaves no undo step.
    expect(bridge.transactionCount).toBe(0);
    // The clip in the Set is untouched.
    expect(bridge.firstClip().notes.map((n) => n.pitch)).toEqual([60, 61, 66, 69]);
  });
});

describe('runScaleLock: typed errors roll the transaction back', () => {
  it('surfaces STALE_REFERENCE for an unknown / empty-slot clip id and commits no undo step', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip(SLOPPY);
    // track:0/clipslot:1/clip is the empty second slot in the withOneMidiClip fixture.
    const staleId = sessionClipId(0, 1);
    await expect(runScaleLock(bridge, { clipIds: [staleId], mode: 'nearest' })).rejects.toSatisfy(
      (e: unknown) => isBridgeErrorOfCode(e, 'STALE_REFERENCE'),
    );
    expect(bridge.transactionCount).toBe(0);
  });

  it('surfaces WRONG_TYPE for an audio clip id and commits no undo step', async () => {
    // The default seeded Set has an AUDIO arrangement clip at track:2/clip:0 (Vocals).
    const bridge = FakeLiveBridge.seeded();
    const audioId = arrangementClipId(2, 0);
    await expect(runScaleLock(bridge, { clipIds: [audioId], mode: 'nearest' })).rejects.toSatisfy(
      (e: unknown) => isBridgeErrorOfCode(e, 'WRONG_TYPE'),
    );
    expect(bridge.transactionCount).toBe(0);
  });

  it('rolls ALL clips back when one id in the batch is bad (no partial write)', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip(SLOPPY);
    const good = bridge.firstClipId;
    const bad = sessionClipId(0, 1); // empty slot -> STALE_REFERENCE
    const before = bridge.firstClip().notes.map((n) => n.pitch);

    await expect(runScaleLock(bridge, { clipIds: [good, bad], mode: 'nearest' })).rejects.toSatisfy(
      (e: unknown) => isBridgeErrorOfCode(e, 'STALE_REFERENCE'),
    );

    // The good clip's notes are untouched: the whole transaction rolled back.
    expect(bridge.firstClip().notes.map((n) => n.pitch)).toEqual(before);
    expect(bridge.transactionCount).toBe(0);
  });
});
