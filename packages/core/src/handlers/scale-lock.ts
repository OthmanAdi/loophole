/**
 * Scale Lock (W1) command handler: the thin read-map-write glue between the
 * {@link LiveBridge} port and the pure {@link snapToScale} transform.
 *
 * This is a ring-2 handler in the architecture of 03_EXTENSIONS_SPEC §0: it imports
 * only the port (DTOs + string ids), never the SDK, so it runs against the
 * {@link import("../fake-live-bridge.js").FakeLiveBridge} with no Ableton install.
 * The `activate()` wiring shell (ring 3) calls this with the real `AbletonLiveBridge`.
 *
 * Flow (03_EXTENSIONS_SPEC §1(b)):
 *  1. read the Set's scale once from {@link LiveBridge.getSongOverview} (`rootNote` +
 *     `scaleIntervals`),
 *  2. inside ONE {@link LiveBridge.transaction} (one undo across all clips), for each
 *     clip read its notes, snap them with {@link snapToScale}, and write them back via
 *     {@link LiveBridge.setNotes}, summing each clip's `movedCount`.
 *
 * The transaction callback is synchronous (per the SDK contract): the `.map` runs to
 * completion, building the `Promise.all` of writes and fully summing `movedCount`,
 * before the returned promise is awaited. A stale or wrong-type clip id makes
 * {@link LiveBridge.getNotes} throw synchronously inside the callback, so the bridge
 * rolls the whole transaction back and rejects with the typed `BridgeError`; no undo
 * step is committed.
 */

import type { NoteDTO, Scale, SnapMode } from '../dtos.js';
import type { ClipId } from '../ids.js';
import type { LiveBridge } from '../live-bridge.js';
import { snapToScale } from '../transforms/scale.js';

/** Arguments for {@link runScaleLock}: the clips to snap and the snap direction. */
export interface ScaleLockArgs {
  /** The MIDI clips to lock to the Set's scale. */
  readonly clipIds: readonly ClipId[];
  /** Snap direction: nearest in-scale pitch, the next one up, or the previous one. */
  readonly mode: SnapMode;
}

/** Result of {@link runScaleLock}: how many notes moved across all the clips. */
export interface ScaleLockResult {
  /** Total notes that changed pitch, summed over every clip. */
  readonly movedCount: number;
}

/**
 * Lock every note in `clipIds` to the scale currently set in the Live Set, in one
 * undo step, and report how many notes moved.
 *
 * Reads the scale from {@link LiveBridge.getSongOverview} (so it never invents a key:
 * it snaps to whatever scale the Set already has). Wraps all clip writes in a single
 * {@link LiveBridge.transaction} so one run is one undo across every clip.
 *
 * @throws BridgeError `STALE_REFERENCE` if a clip id is unknown/deleted, `WRONG_TYPE`
 *   if a clip id is not a MIDI clip (both surfaced by {@link LiveBridge.getNotes} /
 *   {@link LiveBridge.setNotes} from inside the transaction, which then rolls back).
 */
export async function runScaleLock(
  bridge: LiveBridge,
  args: ScaleLockArgs,
): Promise<ScaleLockResult> {
  // A no-op (no clips selected) commits no transaction: no undo step, no read needed.
  if (args.clipIds.length === 0) {
    return { movedCount: 0 };
  }

  const overview = bridge.getSongOverview();
  const scale: Scale = { root: overview.rootNote, intervals: overview.scaleIntervals };

  let movedCount = 0;
  await bridge.transaction(() =>
    Promise.all(
      args.clipIds.map((id) => {
        // getNotes throws synchronously here for a stale / non-MIDI id, which aborts
        // and rolls back the whole transaction (one run stays one undo, or none).
        const current: readonly NoteDTO[] = bridge.getNotes(id);
        const result = snapToScale(current, scale, args.mode);
        movedCount += result.movedCount;
        return bridge.setNotes(id, result.notes);
      }),
    ),
  );

  return { movedCount };
}
