/**
 * The path-id resolver: turns a stable string {@link PathId} into a FRESH, live SDK
 * object by walking `context.application.song` with synchronous getters, on every
 * call (02_BRIDGE_SPEC §3).
 *
 * Why re-resolve every call: a `Handle` is a `bigint` host reference that is NOT
 * permanent. It is invalidated by deletion, by the user moving the track/clip (Live
 * reallocates a new handle), and by session change (01_SDK_MAP §0 Rule C, §9). So
 * this file holds NO cache across calls and never stores or serializes a handle; the
 * canonical address is always the path-id string. Index-based ids shift when objects
 * are inserted/removed mid-session, which is acceptable and made explicit by the
 * error model (a shifted/removed id surfaces as `STALE_REFERENCE`), never papered
 * over with a fake persistent id the SDK does not provide.
 *
 * Resolution maps a segment chain (`track:2/clipslot:4/clip`, `track:2/clip:0`,
 * `track:2/device:1/param:6`, `track:2/mixer/volume`) onto SDK getters, narrowing the
 * base reference types (`ClipSlot.clip: Clip | null`, `Track.arrangementClips:
 * Clip[]`, `Song.tracks: Track[]`) to their concrete subclass with `instanceof` where
 * a caller needs the subtype (01_SDK_MAP §0 Rule B). A missing index/null slot throws
 * `staleReference`; a segment of the wrong kind for the position throws `wrongType`
 * (both from `@othmanadi/loophole-core`), exactly mirroring `FakeLiveBridge`'s resolve
 * helpers so the two implementations agree on the contract.
 *
 * This is one of the files that imports `@ableton-extensions/sdk` (the adapter layer).
 * It is excluded from the committed CI tsconfig and typechecked locally against the
 * real extracted types via `tsconfig.live.json`.
 *
 * RING-3 PENDING: none of the walk has been exercised in a real Live session (there
 * is no Ableton here). The getter chain is typed against the real v1.0.0-beta.0
 * `.d.mts`, but the precise throw semantics of a stale handle (whether the getter
 * throws vs returns) are confirmed only by the manual E2E checklist.
 */

import {
  AudioTrack,
  type Clip,
  type ClipSlot,
  type Device,
  type DeviceParameter,
  type ExtensionContext,
  MidiClip,
  MidiTrack,
  type Song,
  type Track,
  type TrackMixer,
} from '@ableton-extensions/sdk';
import {
  type ClipId,
  clipSlotId as clipSlotIdFor,
  type ClipSlotId,
  type DeviceId,
  parsePath,
  type ParamId,
  type PathId,
  type PathSegment,
  staleReference,
  type TrackId,
  trackId as trackIdFor,
  type TrackKind,
  wrongType,
} from '@othmanadi/loophole-core';

/** The API version the whole adapter pins (see `extension.ts`'s `initialize`). */
export type V = '1.0.0';

/** A resolved clip plus the addressing facts a mapper needs to rebuild its DTO. */
export interface ResolvedClip {
  readonly clip: Clip<V>;
  readonly location: 'session' | 'arrangement';
  /** Present only for a Session clip (so a post-write DTO can echo its slot id). */
  readonly slotId?: ClipSlotId;
}

/** A clip resolved for deletion: either its parent slot, or its track + index. */
export type ResolvedClipForDelete =
  | { readonly kind: 'session'; readonly slot: ClipSlot<V> }
  | { readonly kind: 'arrangement'; readonly track: Track<V>; readonly clip: Clip<V> };

/**
 * Walks the live object tree to resolve path ids. One instance is held by the
 * adapter for the whole session; it stores only the {@link ExtensionContext} (never a
 * resolved object or handle), so every method re-walks from `application.song`.
 */
export class Resolver {
  readonly #context: ExtensionContext<V>;

  constructor(context: ExtensionContext<V>) {
    this.#context = context;
  }

  /** The Set root. `application.song` is non-nullable in the SDK (01_SDK_MAP §1). */
  get song(): Song<V> {
    return this.#context.application.song;
  }

  // --- internal segment helpers ---

  /**
   * Read the first segment of `id`, asserting it is `track:N`, and return the live
   * {@link Track} at that index plus the remaining segments. Shared by every
   * track-rooted resolve (which is all of them in this addressing scheme).
   *
   * @throws BridgeError `WRONG_TYPE` if the head is not an indexed `track` segment,
   *   `STALE_REFERENCE` if no track exists at that index.
   */
  #trackHead(id: PathId): { track: Track<V>; index: number; rest: readonly PathSegment[] } {
    const segments = parsePath(id);
    const head = segments[0];
    if (head === undefined || head.kind !== 'track' || !('index' in head)) {
      throw wrongType(id, 'track');
    }
    const tracks = this.song.tracks;
    const track = tracks[head.index];
    if (track === undefined) {
      throw staleReference(id);
    }
    return { track, index: head.index, rest: segments.slice(1) };
  }

  // --- public resolves (each returns a FRESH live object) ---

  /**
   * Resolve `track:N` to its live {@link Track}. The id must be exactly one
   * `track:N` segment; anything deeper or of another kind is `WRONG_TYPE`.
   */
  resolveTrack(id: TrackId): { track: Track<V>; index: number } {
    const { track, index, rest } = this.#trackHead(id);
    if (rest.length !== 0) {
      throw wrongType(id, 'track');
    }
    return { track, index };
  }

  /**
   * Resolve `track:N` and assert it is the requested concrete kind, returning the
   * narrowed subclass. Used by the arrangement-clip creators and the renderer, which
   * need a {@link MidiTrack} / {@link AudioTrack} specifically.
   *
   * @throws BridgeError `WRONG_TYPE` if the track is not of `kind`.
   */
  resolveTrackOfKind(id: TrackId, kind: 'midi'): { track: MidiTrack<V>; index: number };
  resolveTrackOfKind(id: TrackId, kind: 'audio'): { track: AudioTrack<V>; index: number };
  resolveTrackOfKind(
    id: TrackId,
    kind: TrackKind,
  ): { track: MidiTrack<V> | AudioTrack<V>; index: number } {
    const { track, index } = this.resolveTrack(id);
    if (kind === 'midi') {
      if (!(track instanceof MidiTrack)) {
        throw wrongType(id, 'MIDI track');
      }
      return { track, index };
    }
    if (!(track instanceof AudioTrack)) {
      throw wrongType(id, 'audio track');
    }
    return { track, index };
  }

  /**
   * Resolve a clip-slot id (`track:N/clipslot:M`) to its live {@link ClipSlot} plus
   * its track and indices (the indices let a mapper rebuild the slot/clip ids).
   *
   * @throws BridgeError `WRONG_TYPE` if the shape is not `track:N/clipslot:M`,
   *   `STALE_REFERENCE` if the track or slot index no longer exists.
   */
  resolveSlot(id: ClipSlotId): {
    track: Track<V>;
    trackIndex: number;
    slot: ClipSlot<V>;
    slotIndex: number;
  } {
    const { track, index, rest } = this.#trackHead(id);
    const seg = rest[0];
    if (seg === undefined || seg.kind !== 'clipslot' || !('index' in seg) || rest.length !== 1) {
      throw wrongType(id, 'clip slot');
    }
    const slot = track.clipSlots[seg.index];
    if (slot === undefined) {
      throw staleReference(id);
    }
    return { track, trackIndex: index, slot, slotIndex: seg.index };
  }

  /**
   * Resolve any clip id to its live {@link Clip} plus its location and (for a Session
   * clip) its slot id. Accepts the two legal clip shapes:
   *  - Session clip `track:N/clipslot:M/clip` (via `ClipSlot.clip`, which may be null),
   *  - Arrangement clip `track:N/clip:M` (via `Track.arrangementClips[M]`).
   *
   * Returns the base {@link Clip}; callers that need MIDI vs audio narrow it with
   * {@link Resolver.asMidiClip} / `instanceof`.
   *
   * @throws BridgeError `WRONG_TYPE` for a malformed clip shape, `STALE_REFERENCE` if
   *   any index no longer resolves or the slot is empty.
   */
  resolveClip(id: ClipId): ResolvedClip {
    const { track, index, rest } = this.#trackHead(id);
    const first = rest[0];
    if (first === undefined) {
      throw wrongType(id, 'clip');
    }
    // Arrangement clip: track:N/clip:M
    if (first.kind === 'clip' && 'index' in first) {
      if (rest.length !== 1) {
        throw wrongType(id, 'clip');
      }
      const clip = track.arrangementClips[first.index];
      if (clip === undefined) {
        throw staleReference(id);
      }
      return { clip, location: 'arrangement' };
    }
    // Session clip: track:N/clipslot:M/clip
    if (first.kind === 'clipslot' && 'index' in first) {
      const slot = track.clipSlots[first.index];
      if (slot === undefined) {
        throw staleReference(id);
      }
      const terminal = rest[1];
      if (terminal === undefined || terminal.kind !== 'clip' || 'index' in terminal) {
        throw wrongType(id, 'clip');
      }
      if (rest.length !== 2) {
        throw wrongType(id, 'clip');
      }
      const clip = slot.clip;
      if (clip === null) {
        throw staleReference(id, `Clip slot "${id}" is empty.`);
      }
      return { clip, location: 'session', slotId: clipSlotIdFor(index, first.index) };
    }
    throw wrongType(id, 'clip');
  }

  /**
   * Resolve a clip id to the CONTAINER a delete needs: a Session clip yields its slot
   * ({@link ClipSlot.deleteClip} empties it), an Arrangement clip yields its track +
   * the clip object ({@link Track.deleteClip} removes it). Mirrors the SDK's split
   * delete API (01_SDK_MAP §2: `Track.deleteClip` is arrangement-only).
   *
   * @throws BridgeError `WRONG_TYPE` for a malformed clip shape, `STALE_REFERENCE` if
   *   the clip no longer resolves.
   */
  resolveClipForDelete(id: ClipId): ResolvedClipForDelete {
    const { track, rest } = this.#trackHead(id);
    const first = rest[0];
    if (first === undefined) {
      throw wrongType(id, 'clip');
    }
    if (first.kind === 'clip' && 'index' in first) {
      if (rest.length !== 1) {
        throw wrongType(id, 'clip');
      }
      const clip = track.arrangementClips[first.index];
      if (clip === undefined) {
        throw staleReference(id);
      }
      return { kind: 'arrangement', track, clip };
    }
    if (first.kind === 'clipslot' && 'index' in first) {
      const slot = track.clipSlots[first.index];
      if (slot === undefined) {
        throw staleReference(id);
      }
      const terminal = rest[1];
      if (terminal === undefined || terminal.kind !== 'clip' || 'index' in terminal) {
        throw wrongType(id, 'clip');
      }
      if (rest.length !== 2) {
        throw wrongType(id, 'clip');
      }
      if (slot.clip === null) {
        throw staleReference(id, `Clip slot "${id}" is empty.`);
      }
      return { kind: 'session', slot };
    }
    throw wrongType(id, 'clip');
  }

  /**
   * Narrow a resolved clip to a {@link MidiClip}, the precondition for `getNotes` /
   * `setNotes`. 01_SDK_MAP §0 Rule B: `ClipSlot.clip` / `arrangementClips[]` are typed
   * as base `Clip` but instantiate the most-derived class at runtime, so `instanceof
   * MidiClip` is the intended narrowing.
   *
   * @throws BridgeError `WRONG_TYPE` if the clip is not a MIDI clip.
   */
  asMidiClip(id: ClipId, clip: Clip<V>): MidiClip<V> {
    if (!(clip instanceof MidiClip)) {
      throw wrongType(id, 'MIDI clip');
    }
    return clip;
  }

  /**
   * Resolve a device id (`track:N/device:D`) to its live {@link Device} plus indices.
   *
   * @throws BridgeError `WRONG_TYPE` for a malformed device shape, `STALE_REFERENCE`
   *   if the track or device index no longer resolves.
   */
  resolveDevice(id: DeviceId): {
    device: Device<V>;
    trackIndex: number;
    deviceIndex: number;
  } {
    const { index, rest } = this.#trackHead(id);
    const seg = rest[0];
    if (seg === undefined || seg.kind !== 'device' || !('index' in seg) || rest.length !== 1) {
      throw wrongType(id, 'device');
    }
    const { track } = this.resolveTrack(trackIdFor(index));
    const device = track.devices[seg.index];
    if (device === undefined) {
      throw staleReference(id);
    }
    return { device, trackIndex: index, deviceIndex: seg.index };
  }

  /**
   * Resolve a parameter id to its live {@link DeviceParameter}. Two shapes resolve,
   * matching the addressing scheme + `FakeLiveBridge`:
   *  - a device-chain parameter `track:N/device:D/param:P`, and
   *  - a mixer volume parameter `track:N/mixer/volume` (`Track.mixer.volume`).
   *
   * @throws BridgeError `WRONG_TYPE` for a malformed parameter shape, `STALE_REFERENCE`
   *   if any index no longer resolves.
   */
  resolveParam(id: ParamId): DeviceParameter<V> {
    const { track, rest } = this.#trackHead(id);
    const second = rest[0];
    // Mixer volume: track:N/mixer/volume
    if (second !== undefined && second.kind === 'mixer') {
      const terminal = rest[1];
      if (terminal === undefined || terminal.kind !== 'volume' || rest.length !== 2) {
        throw wrongType(id, 'mixer volume parameter');
      }
      const mixer: TrackMixer<V> = track.mixer;
      return mixer.volume;
    }
    // Device-chain parameter: track:N/device:D/param:P
    const devSeg = rest[0];
    const parSeg = rest[1];
    if (
      devSeg === undefined ||
      devSeg.kind !== 'device' ||
      !('index' in devSeg) ||
      parSeg === undefined ||
      parSeg.kind !== 'param' ||
      !('index' in parSeg) ||
      rest.length !== 2
    ) {
      throw wrongType(id, 'device parameter');
    }
    const device = track.devices[devSeg.index];
    if (device === undefined) {
      throw staleReference(id);
    }
    const param = device.parameters[parSeg.index];
    if (param === undefined) {
      throw staleReference(id);
    }
    return param;
  }
}
