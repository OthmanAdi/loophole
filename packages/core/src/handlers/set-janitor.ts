/**
 * Set Janitor (W6) command handler: read the whole Set through the {@link LiveBridge}
 * port, detect hygiene issues, plan fixes for the issues the user chose, and apply
 * them in exactly ONE transaction (one undo across the whole sweep).
 *
 * This is the ring-2 layer of 03_EXTENSIONS_SPEC §5: it imports only the port (DTOs +
 * string ids), never the SDK, so it runs against {@link FakeLiveBridge} with no
 * Ableton install. The intelligence is the pure {@link detectIssues} / {@link planFixes}
 * transforms; this file is the dumb read-map-write plumbing around them.
 *
 * The transaction shape is the mixed sync-setter + async-delete pattern §5(b)
 * prescribes: renames and recolors go through the bridge's `setTrackProps` /
 * `setClipProps` (each a sync setter under the hood), and deletes go through
 * `deleteTrack` / `deleteClip` (async). All of them are issued inside one synchronous
 * `transaction` callback whose return is a single `Promise.all`, so the whole sweep
 * collapses to one user-facing undo step. Deletes fire only for chosen delete-fixes.
 */

import type { ClipInfo, Fix, SetClipDTO, SetDTO, SetTrackDTO, TrackInfo } from '../dtos.js';
import { leafKind } from '../ids.js';
import type { LiveBridge } from '../live-bridge.js';
import { detectIssues, planFixes } from '../transforms/janitor.js';

/** Arguments for {@link runSetJanitor}: the ids of the issues the user ticked to fix. */
export interface SetJanitorArgs {
  /** The {@link import('../dtos.js').IssueId}s the user chose to fix. */
  readonly chosenIssueIds: readonly string[];
}

/** Result of {@link runSetJanitor}: how many fixes were applied in the sweep. */
export interface SetJanitorResult {
  /** Number of {@link Fix}es applied (one bridge mutation each, all in one undo). */
  readonly applied: number;
}

/**
 * Build a {@link SetClipDTO} from the port's {@link ClipInfo}.
 *
 * Carries `clip.endMarker` straight through, so the loop-overrun rule
 * ({@link detectIssues} comparing `endMarker > loopEnd`) fires through the bridge, not
 * only on hand-built ring-1 DTOs. `ClipInfo` surfaces `endMarker` (it mirrors the SDK's
 * read-only `Clip.endMarker` getter, 01_SDK_MAP §2), so this is a faithful read.
 */
function toSetClip(clip: ClipInfo): SetClipDTO {
  const base = {
    id: clip.id,
    name: clip.name,
    color: clip.color,
    looping: clip.looping,
    loopStart: clip.loopStart,
    loopEnd: clip.loopEnd,
    endMarker: clip.endMarker,
  };
  // Omit slotId when absent (exactOptionalPropertyTypes: a missing key, never
  // slotId: undefined). Present for Session clips so a delete can target the slot.
  return clip.slotId === undefined ? base : { ...base, slotId: clip.slotId };
}

/**
 * Build one {@link SetTrackDTO} from a {@link TrackInfo} and the track's clips. Only
 * real clips are carried (empty Session slots, which `listClips` reports as
 * `kind: 'empty'`, are dropped so the empty-track rule sees a clip-free track as
 * empty).
 */
function toSetTrack(track: TrackInfo, clips: readonly ClipInfo[]): SetTrackDTO {
  return {
    id: track.id,
    kind: track.kind,
    name: track.name,
    deviceCount: track.deviceCount,
    clips: clips.filter((clip) => clip.kind !== 'empty').map(toSetClip),
  };
}

/**
 * Read the whole Set as a plain {@link SetDTO} through the port: one `listTracks`
 * plus one `listClips` per track. SDK-free; every value is a serializable DTO.
 */
function readSet(bridge: LiveBridge): SetDTO {
  const tracks = bridge.listTracks();
  return {
    tracks: tracks.map((track) => toSetTrack(track, bridge.listClips(track.id))),
  };
}

/**
 * Issue the one bridge mutation that applies a single {@link Fix}, returning its
 * Promise so the caller can batch them with `Promise.all` inside the transaction.
 * A `rename` can target a track or a clip, so it dispatches on the target's leaf kind
 * (`setTrackProps` vs `setClipProps`); a `recolor` only ever comes from a clip's
 * off-palette issue, so it routes straight to `setClipProps`; deletes route to
 * `deleteTrack` / `deleteClip`. Every id alias (`TrackId` / `ClipId`) is a `PathId`,
 * so the port methods take `fix.target` directly. The returned Promises are NOT
 * awaited here — that is the transaction's job — so the whole batch is one undo.
 */
function applyFix(bridge: LiveBridge, fix: Fix): Promise<unknown> {
  switch (fix.kind) {
    case 'rename': {
      const name = fix.name ?? '';
      return leafKind(fix.target) === 'track'
        ? bridge.setTrackProps(fix.target, { name })
        : bridge.setClipProps(fix.target, { name });
    }
    case 'recolor':
      return bridge.setClipProps(fix.target, { color: fix.color ?? 0 });
    case 'deleteTrack':
      return bridge.deleteTrack(fix.target);
    case 'deleteClip':
      return bridge.deleteClip(fix.target);
  }
}

/**
 * Run the Set Janitor sweep: read the Set, detect issues, plan fixes for the chosen
 * issue ids, and apply every fix in ONE transaction (one undo). Resolves to the
 * number of fixes applied.
 *
 * The whole write is a single {@link LiveBridge.transaction} whose synchronous
 * callback returns `Promise.all` of every fix's mutation, so renames, recolors, and
 * deletes collapse into one user-facing undo step (03_EXTENSIONS_SPEC §5(b)). When no
 * chosen issue yields a fix, the sweep applies nothing and resolves `{ applied: 0 }`
 * WITHOUT opening a transaction (nothing to undo).
 *
 * @param bridge the {@link LiveBridge} port (real adapter in Live, fake in tests).
 * @param args the chosen issue ids ({@link SetJanitorArgs}).
 */
export async function runSetJanitor(
  bridge: LiveBridge,
  args: SetJanitorArgs,
): Promise<SetJanitorResult> {
  const set = readSet(bridge);
  const issues = detectIssues(set);
  const fixes = planFixes(issues, args.chosenIssueIds);

  if (fixes.length === 0) {
    // No chosen fix: do not open an (empty) transaction / undo step.
    return { applied: 0 };
  }

  await bridge.transaction(() => Promise.all(fixes.map((fix) => applyFix(bridge, fix))));

  return { applied: fixes.length };
}
