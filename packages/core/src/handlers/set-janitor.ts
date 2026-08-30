/**
 * Set Janitor command handler: read the whole Set through the {@link LiveBridge}
 * port, detect hygiene issues, plan fixes for the issues the user chose, and apply
 * them in a deterministic sequence that resolves each opaque target at write time.
 *
 * It imports only the bridge port and serializable domain types, never the host SDK.
 * Renames and recolors are grouped in one transaction. Structural deletes then run
 * serially in snapshot-derived order, and the bridge re-resolves each opaque
 * reference immediately before mutation.
 */

import { isPlayableClip } from '../dtos.js';
import type { ClipInfo, Fix, SetClipDTO, SetDTO, SetTrackDTO, TrackInfo } from '../dtos.js';
import type { ClipId, TrackId } from '../ids.js';
import type { LiveBridge } from '../live-bridge.js';
import { detectIssues, planFixes } from '../transforms/janitor.js';

/** Arguments for {@link runSetJanitor}: the ids of the issues the user ticked to fix. */
export interface SetJanitorArgs {
  /** The {@link import('../dtos.js').IssueId}s the user chose to fix. */
  readonly chosenIssueIds: readonly string[];
  /**
   * Caller-verified complete allowed-color set. Omit it to disable color diagnosis
   * and recoloring; the core does not assume its small reference list is complete.
   */
  readonly allowedClipColors?: ReadonlySet<number>;
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
 * only on hand-built DTOs. `ClipInfo` surfaces the read-only content end marker, so
 * this is a faithful read.
 */
function toSetClip(clip: ClipInfo): SetClipDTO {
  if (!isPlayableClip(clip)) {
    throw new Error('Empty Session slots must not reach Set Janitor clip transforms');
  }
  const id = clip.id;
  const base = {
    id,
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
    clips: clips.filter(isPlayableClip).map(toSetClip),
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

interface ClipOrdinal {
  readonly track: number;
  readonly clip: number;
}

/** Build private ordering metadata from the same immutable snapshot used for detection. */
function snapshotOrdinals(set: SetDTO): {
  readonly tracks: ReadonlyMap<TrackId, number>;
  readonly clips: ReadonlyMap<ClipId, ClipOrdinal>;
} {
  const tracks = new Map<TrackId, number>();
  const clips = new Map<ClipId, ClipOrdinal>();

  set.tracks.forEach((track, trackOrdinal) => {
    tracks.set(track.id, trackOrdinal);
    track.clips.forEach((clip, clipOrdinal) => {
      clips.set(clip.id, { track: trackOrdinal, clip: clipOrdinal });
    });
  });

  return { tracks, clips };
}

/**
 * Order known clip targets by track ascending, then clip descending within a track.
 * A target absent from the read snapshot stays after known targets and is still sent
 * to the bridge, where its stale-reference error remains visible.
 */
function orderClipDeletes(
  fixes: readonly Fix[],
  ordinals: ReadonlyMap<ClipId, ClipOrdinal>,
): Fix[] {
  return [...fixes].sort((left, right) => {
    const leftOrdinal = ordinals.get(left.target as ClipId);
    const rightOrdinal = ordinals.get(right.target as ClipId);
    if (leftOrdinal === undefined) return rightOrdinal === undefined ? 0 : 1;
    if (rightOrdinal === undefined) return -1;
    return leftOrdinal.track - rightOrdinal.track || rightOrdinal.clip - leftOrdinal.clip;
  });
}

/** Order known track targets from highest to lowest snapshot ordinal. */
function orderTrackDeletes(fixes: readonly Fix[], ordinals: ReadonlyMap<TrackId, number>): Fix[] {
  return [...fixes].sort((left, right) => {
    const leftOrdinal = ordinals.get(left.target as TrackId);
    const rightOrdinal = ordinals.get(right.target as TrackId);
    if (leftOrdinal === undefined) return rightOrdinal === undefined ? 0 : 1;
    if (rightOrdinal === undefined) return -1;
    return rightOrdinal - leftOrdinal;
  });
}

/**
 * Issue the one bridge mutation that applies a single {@link Fix}, returning its
 * Promise so the caller can await it in the appropriate mutation phase.
 * A `rename` can target a track or a clip, so it dispatches on the target's leaf kind
 * (`setTrackProps` vs `setClipProps`); a `recolor` only ever comes from a clip's
 * off-palette issue, so it routes straight to `setClipProps`; deletes route to
 * `deleteTrack` / `deleteClip` using the explicit `targetKind` metadata.
 */
function applyFix(bridge: LiveBridge, fix: Fix): Promise<unknown> {
  switch (fix.kind) {
    case 'rename': {
      const name = fix.name ?? '';
      return fix.targetKind === 'track'
        ? bridge.setTrackProps(fix.target as TrackId, { name })
        : bridge.setClipProps(fix.target as ClipId, { name });
    }
    case 'recolor':
      return bridge.setClipProps(fix.target as ClipId, { color: fix.color ?? 0 });
    case 'deleteTrack':
      return bridge.deleteTrack(fix.target as TrackId);
    case 'deleteClip':
      return bridge.deleteClip(fix.target as ClipId);
  }
}

/**
 * Run the Set Janitor sweep: read the Set, detect issues, plan fixes for the chosen
 * issue ids, and apply every fix in a deterministic sequence. Resolves to the number
 * of fixes applied after every phase succeeds.
 *
 * Non-structural renames/recolors share one {@link LiveBridge.transaction}. Clip
 * deletes then run serially by snapshot order: tracks ascending, clips descending
 * within a track. Track deletes follow in descending snapshot order. Structural
 * operations each create their own undo step. If a delete rejects as stale, the
 * error is propagated and later deletes are not attempted; earlier completed phases
 * remain applied and undoable. When no chosen issue yields a fix, the sweep resolves
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
  const ordinals = snapshotOrdinals(set);
  const issues = detectIssues(set, args.allowedClipColors);
  const fixes = planFixes(issues, args.chosenIssueIds, args.allowedClipColors);

  if (fixes.length === 0) {
    // No chosen fix: do not open an (empty) transaction / undo step.
    return { applied: 0 };
  }

  const valueFixes = fixes.filter((fix) => fix.kind === 'rename' || fix.kind === 'recolor');
  const clipDeletes = orderClipDeletes(
    fixes.filter((fix) => fix.kind === 'deleteClip'),
    ordinals.clips,
  );
  const trackDeletes = orderTrackDeletes(
    fixes.filter((fix) => fix.kind === 'deleteTrack'),
    ordinals.tracks,
  );

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
