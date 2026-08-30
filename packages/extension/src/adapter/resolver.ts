/** Fresh SDK-object resolution for opaque, session-scoped Loophole references. */

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
} from '@ableton-extensions/sdk';
import {
  type ClipId,
  type ClipSlotId,
  type DeviceId,
  staleReference,
  type ParamId,
  type TrackId,
  type TrackKind,
  wrongType,
} from '@othmanadi/loophole-core';
import { ReferenceService } from './reference-service.js';

/** The API version the extension pins in `initialize`. */
export type V = '1.0.0';

export interface ResolvedClip {
  readonly clip: Clip<V>;
  readonly location: 'session' | 'arrangement';
  readonly slotId?: ClipSlotId;
  readonly sceneIndex?: number;
}

export type ResolvedClipForDelete =
  | { readonly kind: 'session'; readonly slot: ClipSlot<V> }
  | { readonly kind: 'arrangement'; readonly track: Track<V>; readonly clip: Clip<V> };

/**
 * Resolves references through the session-owned registry, then derives transient array
 * positions only for local SDK operations and issuing response references. Positions
 * are never parsed from or sent over a Loophole reference.
 */
export class Resolver {
  readonly #context: ExtensionContext<V>;
  readonly #references: ReferenceService;

  constructor(context: ExtensionContext<V>, references: ReferenceService) {
    this.#context = context;
    this.#references = references;
  }

  get song(): Song<V> {
    return this.#context.application.song;
  }

  resolveTrack(id: TrackId): { track: Track<V>; index: number } {
    const track = this.#references.resolveTrack(id) as Track<V>;
    const index = this.#indexOf(this.song.tracks, track);
    if (index < 0) throw staleReference(id);
    return { track, index };
  }

  resolveTrackOfKind(id: TrackId, kind: 'midi'): { track: MidiTrack<V>; index: number };
  resolveTrackOfKind(id: TrackId, kind: 'audio'): { track: AudioTrack<V>; index: number };
  resolveTrackOfKind(
    id: TrackId,
    kind: TrackKind,
  ): { track: MidiTrack<V> | AudioTrack<V>; index: number } {
    const { track, index } = this.resolveTrack(id);
    if (kind === 'midi') {
      if (!(track instanceof MidiTrack)) throw wrongType(id, 'MIDI track');
      return { track, index };
    }
    if (!(track instanceof AudioTrack)) throw wrongType(id, 'audio track');
    return { track, index };
  }

  resolveSlot(id: ClipSlotId): {
    track: Track<V>;
    trackIndex: number;
    slot: ClipSlot<V>;
    slotIndex: number;
  } {
    const slot = this.#references.resolveClipSlot(id) as ClipSlot<V>;
    for (const [trackIndex, track] of this.song.tracks.entries()) {
      const slotIndex = this.#indexOf(track.clipSlots, slot);
      if (slotIndex >= 0) return { track, trackIndex, slot, slotIndex };
    }
    throw staleReference(id);
  }

  resolveClip(id: ClipId): ResolvedClip {
    const clip = this.#references.resolveClip(id) as Clip<V>;
    for (const [trackIndex, track] of this.song.tracks.entries()) {
      for (const [sceneIndex, slot] of track.clipSlots.entries()) {
        if (slot.clip === clip && slot.clip.handle.id === clip.handle.id) {
          return {
            clip,
            location: 'session',
            slotId: this.#references.issueClipSlot(slot, trackIndex, sceneIndex),
            sceneIndex,
          };
        }
      }
      if (this.#indexOf(track.arrangementClips, clip) >= 0)
        return { clip, location: 'arrangement' };
    }
    throw staleReference(id);
  }

  resolveClipForDelete(id: ClipId): ResolvedClipForDelete {
    const resolved = this.resolveClip(id);
    if (resolved.location === 'session') {
      const slotId = resolved.slotId;
      if (slotId === undefined) throw staleReference(id);
      return { kind: 'session', slot: this.resolveSlot(slotId).slot };
    }
    for (const track of this.song.tracks) {
      if (this.#indexOf(track.arrangementClips, resolved.clip) >= 0) {
        return { kind: 'arrangement', track, clip: resolved.clip };
      }
    }
    throw staleReference(id);
  }

  asMidiClip(id: ClipId, clip: Clip<V>): MidiClip<V> {
    if (!(clip instanceof MidiClip)) throw wrongType(id, 'MIDI clip');
    return clip;
  }

  resolveDevice(id: DeviceId): { device: Device<V>; trackIndex: number; deviceIndex: number } {
    const device = this.#references.resolveDevice(id) as Device<V>;
    for (const [trackIndex, track] of this.song.tracks.entries()) {
      const deviceIndex = this.#indexOf(track.devices, device);
      if (deviceIndex >= 0) return { device, trackIndex, deviceIndex };
    }
    throw staleReference(id);
  }

  resolveParam(id: ParamId): DeviceParameter<V> {
    return this.#references.resolveParameter(id) as DeviceParameter<V>;
  }

  #indexOf<T extends { readonly handle: { readonly id: bigint } }>(
    objects: readonly T[],
    target: T,
  ): number {
    return objects.findIndex(
      (object) => object === target && object.handle.id === target.handle.id,
    );
  }
}
