/**
 * Reverse resolution: turn the SDK {@link Handle}(s) a context-menu command receives
 * into the stable core {@link PathId}s the pure command handlers drive.
 *
 * The forward direction (path id to a fresh `Handle`) lives in {@link Resolver}; this
 * is the inverse, and it is the ONE new SDK-facing capability Wave C stage 2 needs. A
 * context-menu action does not hand us a path id; it hands us the object the user
 * right-clicked, as a `Handle` (clip / track scopes) or a selection of handles
 * (`ClipSlotSelection.selected_clip_slots`, `ArrangementSelection.selected_lanes`). To
 * call a handler that speaks `ClipId` / `TrackId`, we locate that object's position in
 * `application.song` and rebuild its path id, exactly the address the {@link Resolver}
 * re-resolves on the next call.
 *
 * How the position is found: every SDK object extends `DataModelObject`, which exposes
 * a `readonly handle: Handle` (`{ id: bigint }`). So we resolve the received handle to
 * its typed object, then walk the relevant array (`song.tracks`, `track.clipSlots`,
 * `track.arrangementClips`) and match by `handle.id` equality, the same identity check
 * the adapter already uses for cue points (`live-bridge.ableton.ts`: `cp.handle.id ===
 * created.handle.id`). The matched index becomes the path-id segment.
 *
 * This file imports `@ableton-extensions/sdk` (types + `instanceof` classes), so it is
 * an adapter-layer file: excluded from the committed CI tsconfig, typechecked locally
 * against the real `.d.mts` via `tsconfig.live.json`.
 *
 * RING-3 PENDING (no Ableton here): the precise handle a given scope passes, and
 * whether a right-clicked Session clip is always reachable through its slot, are typed
 * against v1.0.0-beta.0 but confirmed only by the manual E2E checklist. The match logic
 * is pure index arithmetic over typed getters.
 */

import {
  type ArrangementSelection,
  AudioTrack,
  type Clip,
  ClipSlot,
  type ClipSlotSelection,
  DataModelObject,
  type ExtensionContext,
  type Handle,
  MidiClip,
  MidiTrack,
  type Track,
} from '@ableton-extensions/sdk';
import {
  arrangementClipId,
  type ClipId,
  sessionClipId,
  type TrackId,
  trackId,
} from '@othmanadi/loophole-core';
import type { V } from './resolver.js';

/**
 * Locate `target` among `objects` by `Handle` id and return its index, or `-1` when it
 * is not present. The identity comparison is `handle.id` (a `bigint`) equality, the
 * same check the adapter uses elsewhere; SDK object caching means the same Live object
 * yields the same handle id, so this is stable within a resolution.
 */
function indexByHandle(objects: readonly DataModelObject<V>[], target: Handle): number {
  return objects.findIndex((object) => object.handle.id === target.id);
}

/**
 * Resolve a right-clicked clip {@link Handle} (from a `"MidiClip"` / `"AudioClip"`
 * scope) to its stable {@link ClipId} by finding which track and slot/arrangement
 * position holds it. Searches each track's Session clip slots first, then its
 * Arrangement clips, matching by `handle.id`.
 *
 * @returns the clip's {@link ClipId}, or `null` if the clip is not found in the tree
 *   (deleted between the right-click and now, or otherwise unreachable). Callers turn a
 *   `null` into a user-facing "could not locate the clip" rather than guessing.
 */
export function clipIdFromHandle(context: ExtensionContext<V>, handle: Handle): ClipId | null {
  // Resolve to the typed clip so a single matched handle is reused by identity below.
  const clip = context.getObjectFromHandle(handle, DataModelObject) as DataModelObject<V>;
  const song = context.application.song;
  const tracks = song.tracks;
  for (let t = 0; t < tracks.length; t += 1) {
    const track = tracks[t];
    if (track === undefined) {
      continue;
    }
    const slots = track.clipSlots;
    for (let s = 0; s < slots.length; s += 1) {
      const slot = slots[s];
      if (slot?.clip != null && slot.clip.handle.id === clip.handle.id) {
        return sessionClipId(t, s);
      }
    }
    const arrangementClips = track.arrangementClips;
    for (let c = 0; c < arrangementClips.length; c += 1) {
      const arrangementClip = arrangementClips[c];
      if (arrangementClip !== undefined && arrangementClip.handle.id === clip.handle.id) {
        return arrangementClipId(t, c);
      }
    }
  }
  return null;
}

/**
 * Resolve a right-clicked track {@link Handle} (from an `"AudioTrack"` / `"MidiTrack"`
 * scope) to its stable {@link TrackId} by its index in `song.tracks`.
 *
 * @returns the {@link TrackId}, or `null` if the track is not found (deleted / moved
 *   off the indexed list).
 */
export function trackIdFromHandle(context: ExtensionContext<V>, handle: Handle): TrackId | null {
  const track = context.getObjectFromHandle(handle, DataModelObject) as DataModelObject<V>;
  const index = indexByHandle(context.application.song.tracks, track.handle);
  return index < 0 ? null : trackId(index);
}

/**
 * Resolve every MIDI clip in a {@link ClipSlotSelection} (the `"ClipSlotSelection"`
 * scope) to its {@link ClipId}. Each selected slot handle is matched to its `(track,
 * slot)` position; a slot that is empty or holds a non-MIDI clip is skipped (Scale Lock
 * and Humanize act on MIDI clips only, 03_EXTENSIONS_SPEC §1(c)/§2(c)). De-duplicates
 * while preserving first-seen order.
 *
 * @returns the MIDI {@link ClipId}s among the selection, in selection order.
 */
export function midiClipIdsFromSlotSelection(
  context: ExtensionContext<V>,
  selection: ClipSlotSelection,
): ClipId[] {
  const song = context.application.song;
  const tracks = song.tracks;
  const ids: ClipId[] = [];
  const seen = new Set<string>();
  for (const slotHandle of selection.selected_clip_slots) {
    const located = locateSlot(context, tracks, slotHandle);
    if (located === null) {
      continue;
    }
    const clip = located.slot.clip;
    if (clip == null || !(clip instanceof MidiClip)) {
      continue;
    }
    const id = sessionClipId(located.trackIndex, located.slotIndex);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Find the `(track, slot)` position of a clip-slot {@link Handle} within the Set. Used
 * by {@link midiClipIdsFromSlotSelection}: a `ClipSlotSelection` carries slot handles,
 * not clip handles, so we match the slot itself, then read its clip.
 */
function locateSlot(
  context: ExtensionContext<V>,
  tracks: readonly Track<V>[],
  slotHandle: Handle,
): { trackIndex: number; slotIndex: number; slot: ClipSlot<V> } | null {
  const slotObject = context.getObjectFromHandle(slotHandle, ClipSlot);
  for (let t = 0; t < tracks.length; t += 1) {
    const track = tracks[t];
    if (track === undefined) {
      continue;
    }
    const index = indexByHandle(track.clipSlots, slotObject.handle);
    if (index >= 0) {
      const slot = track.clipSlots[index];
      if (slot !== undefined) {
        return { trackIndex: t, slotIndex: index, slot };
      }
    }
  }
  return null;
}

/**
 * Resolve every audio track lane in an {@link ArrangementSelection} (the
 * `"AudioTrack.ArrangementSelection"` scope) to its {@link TrackId}. Each selected lane
 * handle is resolved and kept only when it is an {@link AudioTrack} (Gain Stage Doctor
 * renders audio tracks only, 03_EXTENSIONS_SPEC §3). De-duplicates, preserving order.
 *
 * @returns the audio-track {@link TrackId}s in the selection, plus the selection's beat
 *   range, so the caller can bound the render to exactly what the user selected.
 */
export function audioTrackSelectionToTargets(
  context: ExtensionContext<V>,
  selection: ArrangementSelection,
): { trackIds: TrackId[]; startBeat: number; endBeat: number } {
  const tracks = context.application.song.tracks;
  const ids: TrackId[] = [];
  const seen = new Set<string>();
  for (const laneHandle of selection.selected_lanes) {
    const lane = context.getObjectFromHandle(laneHandle, DataModelObject) as DataModelObject<V>;
    if (!(lane instanceof AudioTrack)) {
      continue;
    }
    const index = indexByHandle(tracks, lane.handle);
    if (index < 0) {
      continue;
    }
    const id = trackId(index);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return {
    trackIds: ids,
    startBeat: selection.time_selection_start,
    endBeat: selection.time_selection_end,
  };
}

/**
 * Narrow a resolved clip to whether it is a MIDI clip (for a single-clip scope). The
 * runtime registry instantiates the concrete subclass, so `instanceof MidiClip` is the
 * documented narrowing (01_SDK_MAP §0 Rule B). Exposed so a command can refuse a
 * non-MIDI right-click before opening a modal.
 */
export function isMidiClipHandle(context: ExtensionContext<V>, handle: Handle): boolean {
  const clip = context.getObjectFromHandle(handle, DataModelObject);
  return clip instanceof MidiClip;
}

/** Re-export the SDK classes a command needs for its own `instanceof` refusals. */
export { AudioTrack, type Clip, MidiClip, MidiTrack };
