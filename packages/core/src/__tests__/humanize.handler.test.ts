/**
 * Ring 2 tests for the Humanize command handler against the FakeLiveBridge, with no
 * Ableton install. They pin the §2(f) ring-2 claims: a fixed-seed rng over a seeded
 * clip produces an exact stored-notes array, and the whole pass is exactly ONE undo
 * step (`transactionCount` grows by one). Stale / wrong-type ids propagate the typed
 * error and roll the transaction back.
 */

import { describe, expect, it } from 'vitest';

import type { HumanizeOpts, NoteDTO } from '../dtos.js';
import { isBridgeErrorOfCode } from '../errors.js';
import { FakeLiveBridge } from '../fake-live-bridge.js';
import { runHumanize } from '../handlers/humanize.js';
import { arrangementClipId, sessionClipId } from '../ids.js';

/** A deterministic rng: returns `values` in order, cycling. */
function seqRng(values: readonly number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v ?? 0;
  };
}

/** The three-note clip the headline ring-2 test seeds and humanises. */
const SEED_NOTES: readonly NoteDTO[] = [
  { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
  { pitch: 64, startTime: 1, duration: 1, velocity: 90 },
  { pitch: 67, startTime: 2, duration: 1, velocity: 80 },
];

describe('runHumanize: read -> humanize -> write round-trip on the fake', () => {
  it('stores exactly the notes the pure transform produces for a fixed seed', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip(SEED_NOTES);
    const opts: HumanizeOpts = {
      strength: 0.5,
      doTiming: true,
      doVelocity: true,
      doDuration: false,
    };
    // Six draws (timing + velocity per note), grid is 1/16 (beatsPerCell 0.25):
    //  note 0: t 0.0 -> -0.125 -> clamp 0;   v 1.0 -> 100 + 32 = 132 -> clamp 127
    //  note 1: t 0.5 ->  1 (factor 0);        v 0.5 -> 90 (factor 0)
    //  note 2: t 1.0 ->  2.125;               v 0.0 -> 80 - 32 = 48
    const result = await runHumanize(
      bridge,
      { clipIds: [bridge.firstClipId], opts },
      seqRng([0.0, 1.0, 0.5, 0.5, 1.0, 0.0]),
    );

    expect(result.clipCount).toBe(1);
    expect(bridge.firstClip().notes).toEqual([
      { pitch: 60, startTime: 0, duration: 1, velocity: 127 },
      { pitch: 64, startTime: 1, duration: 1, velocity: 90 },
      { pitch: 67, startTime: 2.125, duration: 1, velocity: 48 },
    ]);
  });

  it('commits exactly one undo step (transactionCount + 1)', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip(SEED_NOTES);
    expect(bridge.transactionCount).toBe(0);
    await runHumanize(
      bridge,
      {
        clipIds: [bridge.firstClipId],
        opts: { strength: 0.5, doTiming: true, doVelocity: true, doDuration: false },
      },
      seqRng([0.2, 0.8]),
    );
    expect(bridge.transactionCount).toBe(1);
  });

  it('humanises several clips in ONE undo step', async () => {
    // The seeded Set has MIDI clips on Drums (track 0) and Bass (track 1).
    const bridge = FakeLiveBridge.seeded();
    expect(bridge.transactionCount).toBe(0);
    const result = await runHumanize(
      bridge,
      {
        clipIds: [sessionClipId(0, 0), sessionClipId(1, 0)],
        opts: { strength: 0.6, doTiming: true, doVelocity: true, doDuration: false },
      },
      seqRng([0.1, 0.9, 0.4, 0.6]),
    );
    expect(result.clipCount).toBe(2);
    // Two clips, one transaction.
    expect(bridge.transactionCount).toBe(1);
  });

  it('strength 0 writes the notes back unchanged but still as one undo', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip(SEED_NOTES);
    await runHumanize(
      bridge,
      {
        clipIds: [bridge.firstClipId],
        opts: { strength: 0, doTiming: true, doVelocity: true, doDuration: true },
      },
      seqRng([0.5]),
    );
    // Identity transform: the stored notes equal the seed (the fake echoes them back).
    expect(bridge.firstClip().notes).toEqual(SEED_NOTES);
    expect(bridge.transactionCount).toBe(1);
  });

  it('reads the grid from the overview (a 1/16 fixture bounds the timing nudge)', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip([
      { pitch: 60, startTime: 2, duration: 1, velocity: 64 },
    ]);
    // Full strength, timing only, rng=1 -> +one cell (0.25) -> 2.25 on the 1/16 grid.
    await runHumanize(
      bridge,
      {
        clipIds: [bridge.firstClipId],
        opts: { strength: 1, doTiming: true, doVelocity: false, doDuration: false },
      },
      seqRng([1]),
    );
    expect(bridge.firstClip().notes[0]?.startTime).toBeCloseTo(2.25, 10);
  });

  it('does nothing and commits no transaction for an empty clip list', async () => {
    const bridge = FakeLiveBridge.withOneMidiClip(SEED_NOTES);
    const result = await runHumanize(
      bridge,
      { clipIds: [], opts: { strength: 1, doTiming: true, doVelocity: true, doDuration: true } },
      seqRng([0.5]),
    );
    expect(result.clipCount).toBe(0);
    // No clips selected: no transaction opened, so the no-op leaves no undo step.
    expect(bridge.transactionCount).toBe(0);
    // The clip in the Set is untouched.
    expect(bridge.firstClip().notes).toEqual(SEED_NOTES);
  });
});

describe('runHumanize: errors propagate and roll back', () => {
  it('throws WRONG_TYPE for a non-MIDI clip and commits no undo step', async () => {
    // The seeded Set's Vocals track (2) holds one AUDIO arrangement clip.
    const bridge = FakeLiveBridge.seeded();
    await expect(
      runHumanize(
        bridge,
        {
          clipIds: [arrangementClipId(2, 0)],
          opts: { strength: 0.5, doTiming: true, doVelocity: true, doDuration: false },
        },
        seqRng([0.5]),
      ),
    ).rejects.toSatisfy((e: unknown) => isBridgeErrorOfCode(e, 'WRONG_TYPE'));
    expect(bridge.transactionCount).toBe(0);
  });

  it('throws STALE_REFERENCE for a missing clip and leaves the others untouched', async () => {
    const bridge = FakeLiveBridge.seeded();
    const before = bridge.getNotes(sessionClipId(0, 0));
    await expect(
      runHumanize(
        bridge,
        {
          // One good clip and one missing clip: the whole transaction rolls back.
          clipIds: [sessionClipId(0, 0), sessionClipId(0, 9)],
          opts: { strength: 1, doTiming: true, doVelocity: true, doDuration: false },
        },
        seqRng([0.3, 0.7]),
      ),
    ).rejects.toSatisfy((e: unknown) => isBridgeErrorOfCode(e, 'STALE_REFERENCE'));
    // Rolled back: the good clip is unchanged and no undo step was committed.
    expect(bridge.getNotes(sessionClipId(0, 0))).toEqual(before);
    expect(bridge.transactionCount).toBe(0);
  });
});
