/**
 * Command handler for Humanize / Groove Sculptor (W2), 03_EXTENSIONS_SPEC §2(b).
 *
 * This is the ring-2 layer: it reads the Set through the {@link LiveBridge} port,
 * feeds plain note data to the pure {@link humanize} transform, and writes the result
 * back, all inside ONE transaction so the whole pass is a single undo. It imports only
 * the port (DTOs + string ids) and the pure transform; it never imports the SDK, so it
 * runs on CI against {@link import('../fake-live-bridge.js').FakeLiveBridge} with no
 * Ableton install.
 *
 * The transaction shape is the §2(b) one verbatim: `clip.notes =` is a synchronous
 * setter, but the port models a notes write as the async {@link LiveBridge.setNotes}
 * (one queued transaction each), so to collapse N clips into one undo the callback
 * stays synchronous and returns `Promise.all([...])` of the per-clip writes. The grid
 * is read and derived BEFORE the transaction opens (a read needs no transaction), and
 * `humanize` runs synchronously inside the callback on the synchronously-read notes.
 */

import type { HumanizeOpts, NoteDTO } from '../dtos.js';
import type { ClipId } from '../ids.js';
import type { LiveBridge } from '../live-bridge.js';
import { gridInfoFrom, humanize } from '../transforms/groove.js';

/** Arguments for {@link runHumanize}: the clips to humanise and the modal options. */
export interface HumanizeArgs {
  /** The target MIDI clips (e.g. the right-clicked clip selection). */
  readonly clipIds: readonly ClipId[];
  /** The per-axis gates and amounts from the Humanize modal. */
  readonly opts: HumanizeOpts;
}

/**
 * Humanize every clip in `args.clipIds` in one undo step.
 *
 * Reads the Set grid from {@link LiveBridge.getSongOverview} and derives the
 * {@link import('../dtos.js').GridInfo} (`beatsPerCell`) the transform needs, then
 * opens one transaction whose synchronous callback reads each clip's notes, runs the
 * pure {@link humanize} over them with the injected `rng`, and returns a
 * `Promise.all` of the per-clip {@link LiveBridge.setNotes} writes. The whole batch is
 * one user-facing undo.
 *
 * `rng` is injected for determinism, exactly as the transform requires: `activate()`
 * passes a real PRNG, tests pass a fixed-seed PRNG. It is threaded straight through to
 * {@link humanize}, so the per-clip note order and the documented per-note draw order
 * make a seeded run exactly reproducible.
 *
 * @returns the number of clips humanised (`clipCount`), so the UI can report "N clips".
 * @throws BridgeError `STALE_REFERENCE` / `WRONG_TYPE` if a clip id is gone or is not a
 *   MIDI clip (propagated from {@link LiveBridge.getNotes} / {@link LiveBridge.setNotes};
 *   any rejection rolls the whole transaction back so it stays one undo).
 */
export async function runHumanize(
  bridge: LiveBridge,
  args: HumanizeArgs,
  rng: () => number,
): Promise<{ clipCount: number }> {
  const { clipIds, opts } = args;
  // A no-op (no clips selected) commits no transaction: no undo step.
  if (clipIds.length === 0) {
    return { clipCount: 0 };
  }

  // Read + derive the grid before opening the transaction (a read needs no undo step).
  const overview = bridge.getSongOverview();
  const grid = gridInfoFrom(overview.gridQuantization, overview.gridIsTriplet);

  // One transaction = one undo. The callback is SYNCHRONOUS: it reads each clip's notes
  // (sync getter), maps them through the pure transform (sync), and returns a
  // Promise.all of the async setNotes writes. Never `await` inside the callback.
  await bridge.transaction(() =>
    Promise.all(
      clipIds.map((id) => {
        const humanized: readonly NoteDTO[] = humanize([...bridge.getNotes(id)], opts, grid, rng);
        return bridge.setNotes(id, humanized);
      }),
    ),
  );

  return { clipCount: clipIds.length };
}
