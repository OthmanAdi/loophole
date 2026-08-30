/**
 * Set Janitor (W6) command handler: read the whole Set through the {@link LiveBridge}
 * port, detect hygiene issues, plan fixes for the issues the user chose, and apply
 * them in a deterministic sequence that keeps position-based targets honest.
 *
 * This is the ring-2 layer of 03_EXTENSIONS_SPEC §5: it imports only the port (DTOs +
 * string ids), never the SDK, so it runs against {@link FakeLiveBridge} with no
 * Ableton install. The intelligence is the pure {@link detectIssues} / {@link planFixes}
 * transforms; this file is the dumb read-map-write plumbing around them.
 *
 * The transaction shape is the mixed sync-setter + async-delete pattern §5(b)
 * prescribes: renames and recolors go through the bridge's `setTrackProps` /
 * `setClipProps` (each a sync setter under the hood), and deletes go through
 * `deleteTrack` / `deleteClip` (async). Value edits are grouped in one transaction.
 * Structural deletes then run serially: clips from highest to lowest index within a
 * track, followed by tracks from highest to lowest index. This prevents an earlier
 * splice from silently retargeting a later position-based id. Deletes fire only for
 * chosen delete-fixes.
 */

import type { ClipInfo, Fix, SetClipDTO, SetDTO, SetTrackDTO, TrackInfo } from '../dtos.js';
import { leafKind, parsePath, type PathSegment } from '../ids.js';
import type { LiveBridge } from '../live-bridge.js';
import { detectIssues, planFixes } from '../transforms/janitor.js';

/** Arguments for {@link runSetJanitor}: the ids of the issues the user ticked to fix. */
export interface SetJanitorArgs {
  /** The {@link import('../dtos.js').IssueId}s the user chose to fix. */
  readonly chosenIssueIds: readonly string[];
}

/** Result of {@link runSetJanitor}: how many fixes were applied in the sweep. */
export interface SetJanitorResult {
  /** Number of {@link Fix}es applied after the complete sequence succeeds. */
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
 * Promise so the caller can await it in the appropriate mutation phase.
 * A `rename` can target a track or a clip, so it dispatches on the target's leaf kind
 * (`setTrackProps` vs `setClipProps`); a `recolor` only ever comes from a clip's
 * off-palette issue, so it routes straight to `setClipProps`; deletes route to
 * `deleteTrack` / `deleteClip`. Every id alias (`TrackId` / `ClipId`) is a `PathId`,
 * so the port methods take `fix.target` directly.
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

/** Return the numeric index carried by a parsed path segment, or fail loudly. */
function segmentIndex(segment: PathSegment | undefined, target: Fix['target']): number {
  if (segment === undefined || !('index' in segment)) {
    throw new TypeError(`Structural fix target "${target}" has no sortable index.`);
  }
  return segment.index;
}

/**
 * Sort clip deletes without mutating the planner's output. Tracks are visited in
 * stable ascending order; inside each track, higher slot/Arrangement indices are
 * deleted first so an Arrangement-array splice cannot shift a later target.
 */
function orderClipDeletes(fixes: readonly Fix[]): Fix[] {
  return [...fixes].sort((left, right) => {
    const leftPath = parsePath(left.target);
    const rightPath = parsePath(right.target);
    const trackOrder =
      segmentIndex(leftPath[0], left.target) - segmentIndex(rightPath[0], right.target);
    if (trackOrder !== 0) {
      return trackOrder;
    }

    return segmentIndex(rightPath[1], right.target) - segmentIndex(leftPath[1], left.target);
  });
}

/** Sort track deletes from highest to lowest position so earlier splices stay safe. */
function orderTrackDeletes(fixes: readonly Fix[]): Fix[] {
  return [...fixes].sort(
    (left, right) =>
      segmentIndex(parsePath(right.target)[0], right.target) -
      segmentIndex(parsePath(left.target)[0], left.target),
  );
}

/**
 * Run the Set Janitor sweep: read the Set, detect issues, plan fixes for the chosen
 * issue ids, and apply every fix in a deterministic sequence. Resolves to the number
 * of fixes applied after every phase succeeds.
 *
 * Non-structural renames/recolors share one {@link LiveBridge.transaction}. Clip
 * deletes then run serially, descending within each track, and track deletes run
 * serially in descending track order. Structural operations therefore each create
 * their own undo step. This intentionally trades a single sweep-wide undo for safe,
 * deterministic position-based deletion. If a delete rejects as stale, the error is
 * propagated and later deletes are not attempted; earlier completed phases remain
 * applied and undoable. When no chosen issue yields a fix, the sweep resolves
 * `{ applied: 0 }` without opening a transaction.
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

  const valueFixes = fixes.filter((fix) => fix.kind === 'rename' || fix.kind === 'recolor');
  const clipDeletes = orderClipDeletes(fixes.filter((fix) => fix.kind === 'deleteClip'));
  const trackDeletes = orderTrackDeletes(fixes.filter((fix) => fix.kind === 'deleteTrack'));

  if (valueFixes.length > 0) {
    await bridge.transaction(() => Promise.all(valueFixes.map((fix) => applyFix(bridge, fix))));
  }

  for (const fix of clipDeletes) {
    await applyFix(bridge, fix);
  }

  for (const fix of trackDeletes) {
    await applyFix(bridge, fix);
  }

  return { applied: fixes.length };
}
