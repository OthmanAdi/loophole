/**
 * Pure translation from live SDK objects to the serializable core DTOs the {@link
 * import("@othmanadi/loophole-core").LiveBridge} port speaks (02_BRIDGE_SPEC §9).
 *
 * Every mapper reads SDK getters and emits a plain DTO carrying NAMES and string
 * {@link import("@othmanadi/loophole-core").PathId}s only: no `Handle`, no `bigint`,
 * no SDK type ever crosses out of the adapter (02_BRIDGE_SPEC §3, the locked import
 * boundary). The path ids are passed in by the adapter (which knows the indices from
 * the resolve walk) or built with the core id builders, so they round-trip through the
 * {@link import("./resolver.js").Resolver}.
 *
 * Sync vs async (01_SDK_MAP §0 Rule A): nearly every getter is synchronous, so most
 * mappers are sync. The sole exception is a {@link DeviceParameter}'s current value —
 * `DeviceParameter.getValue()` is `[async]` — so {@link paramInfo} and everything that
 * embeds a param value ({@link deviceInfo}, {@link trackMixerInfo}, {@link mixerInfo})
 * are async and `await` that one call. `min` / `max` / `defaultValue` / `isQuantized`
 * are sync getters, read directly. Those values are the parameter's INTERNAL units
 * (raw, not display), matching `DeviceParamInfo` (01_SDK_MAP §2 DeviceParameter note).
 *
 * This file imports `@ableton-extensions/sdk` (as types plus the `instanceof` classes),
 * so it lives in the adapter layer: excluded from the committed CI tsconfig, typechecked
 * locally against the real `.d.mts` via `tsconfig.live.json`.
 *
 * RING-3 PENDING: numeric color values, the audio `filePath` shape, and the exact
 * `mutedViaSolo` interaction are typed against v1.0.0-beta.0 but unverified in a real
 * Set (no Ableton here); confirmed by the manual E2E checklist.
 */

import {
  AudioClip,
  type Clip,
  type Device,
  type DeviceParameter,
  MidiClip,
  MidiTrack,
  type NoteDescription,
  type Scene,
  type Track,
  type TrackMixer,
} from '@ableton-extensions/sdk';
import {
  type ClipId,
  type ClipInfo,
  type ClipLocation,
  type ClipSlotId,
  type CuePointInfo,
  cuePointId,
  deviceId,
  type DeviceInfo,
  type DeviceParamInfo,
  type MixerInfo,
  mixerVolumeParamId,
  type NoteDTO,
  type ParamId,
  paramId,
  sceneId,
  type SceneInfo,
  trackId,
  type TrackInfo,
  type TrackKind,
  type TrackMixerInfo,
} from '@othmanadi/loophole-core';
import type { V } from './resolver.js';

// --- notes ---

/**
 * Map an SDK {@link NoteDescription} to a {@link NoteDTO}, dropping any optional field
 * the host did not report (a MISSING key, never `key: undefined`, per
 * `exactOptionalPropertyTypes`). The fields are a one-to-one match (01_SDK_MAP §3); no
 * clamping happens here (reads pass values through; writes clamp on the way in).
 */
export function noteToDTO(note: NoteDescription): NoteDTO {
  const out: {
    pitch: number;
    startTime: number;
    duration: number;
    velocity?: number;
    muted?: boolean;
    probability?: number;
    velocityDeviation?: number;
    releaseVelocity?: number;
    selected?: boolean;
  } = { pitch: note.pitch, startTime: note.startTime, duration: note.duration };
  if (note.velocity !== undefined) out.velocity = note.velocity;
  if (note.muted !== undefined) out.muted = note.muted;
  if (note.probability !== undefined) out.probability = note.probability;
  if (note.velocityDeviation !== undefined) out.velocityDeviation = note.velocityDeviation;
  if (note.releaseVelocity !== undefined) out.releaseVelocity = note.releaseVelocity;
  if (note.selected !== undefined) out.selected = note.selected;
  return out;
}

/** Clamp a value to the MIDI 0..127 range Live enforces on note pitch / velocity. */
function clamp127(value: number): number {
  if (value < 0) return 0;
  if (value > 127) return 127;
  return value;
}

/**
 * Map a core {@link NoteDTO} to the SDK's {@link NoteDescription} for a WRITE, clamping
 * pitch and velocities to 0..127 the way Live rejects out-of-range values (the port's
 * `setNotes` contract; mirrors `FakeLiveBridge`). Absent optional fields are left off,
 * never set to `undefined` (`exactOptionalPropertyTypes`).
 */
export function noteToDescription(dto: NoteDTO): NoteDescription {
  const out: NoteDescription = {
    pitch: clamp127(dto.pitch),
    startTime: dto.startTime,
    duration: dto.duration,
  };
  if (dto.velocity !== undefined) out.velocity = clamp127(dto.velocity);
  if (dto.muted !== undefined) out.muted = dto.muted;
  if (dto.probability !== undefined) out.probability = dto.probability;
  if (dto.velocityDeviation !== undefined) out.velocityDeviation = dto.velocityDeviation;
  if (dto.releaseVelocity !== undefined) out.releaseVelocity = clamp127(dto.releaseVelocity);
  if (dto.selected !== undefined) out.selected = dto.selected;
  return out;
}

// --- tracks ---

/**
 * Concrete kind of a track. The SDK types `Song.tracks` as base `Track`, but the
 * runtime registry instantiates `MidiTrack` / `AudioTrack`, so `instanceof MidiTrack`
 * is the documented narrowing (01_SDK_MAP §0 Rule B). Anything not a MIDI track is an
 * audio track in this model.
 */
export function trackKind(track: Track<V>): TrackKind {
  return track instanceof MidiTrack ? 'midi' : 'audio';
}

/**
 * Map a live {@link Track} to a {@link TrackInfo}. The structural counts and flags are
 * sync getters; the {@link MixerInfo} is built separately (it is async, because a
 * mixer parameter's value is async) and passed in, so this stays a thin shaping step.
 */
export function trackInfo(track: Track<V>, index: number, mixer: MixerInfo): TrackInfo {
  return {
    id: trackId(index),
    kind: trackKind(track),
    name: track.name,
    mute: track.mute,
    solo: track.solo,
    mutedViaSolo: track.mutedViaSolo,
    arm: track.arm,
    clipSlotCount: track.clipSlots.length,
    arrangementClipCount: track.arrangementClips.length,
    deviceCount: track.devices.length,
    mixer,
  };
}

// --- clips ---

/**
 * Map a live {@link Clip} to a {@link ClipInfo}. `kind` / `isMidi` come from the
 * concrete subclass (`instanceof MidiClip` / `AudioClip`); the geometry fields are
 * sync getters (01_SDK_MAP §2 Clip). `filePath` is set ONLY for an audio clip (a
 * missing key for MIDI, per `exactOptionalPropertyTypes`); `slotId` only for a Session
 * clip. `endMarker` is read directly so Set Janitor's loop-overrun rule can compare it
 * against `loopEnd` through the port.
 */
export function clipInfo(
  clip: Clip<V>,
  id: ClipId,
  location: ClipLocation,
  slotId?: ClipSlotId,
): ClipInfo {
  const isMidi = clip instanceof MidiClip;
  const base = {
    id,
    isMidi,
    kind: isMidi ? ('midi' as const) : ('audio' as const),
    location,
    name: clip.name,
    startTime: clip.startTime,
    endTime: clip.endTime,
    duration: clip.duration,
    looping: clip.looping,
    loopStart: clip.loopStart,
    loopEnd: clip.loopEnd,
    endMarker: clip.endMarker,
    color: clip.color,
    muted: clip.muted,
  };
  const withSlot = slotId === undefined ? base : { ...base, slotId };
  if (clip instanceof AudioClip) {
    return { ...withSlot, filePath: clip.filePath };
  }
  return withSlot;
}

/**
 * An empty Session clip slot, reported by `listClips` so the model can see where it
 * may create a clip (DTO contract: `kind: 'empty'`, geometry zeroed, id == slot id).
 */
export function emptySlotInfo(slotId: ClipSlotId): ClipInfo {
  return {
    id: slotId,
    isMidi: false,
    kind: 'empty',
    location: 'session',
    slotId,
    name: '',
    startTime: 0,
    endTime: 0,
    duration: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
    endMarker: 0,
    color: 0,
    muted: false,
  };
}

// --- device parameters (async: getValue is the one async getter) ---

/**
 * Map a live {@link DeviceParameter} to a {@link DeviceParamInfo}. ASYNC because the
 * current value comes from `getValue()` (`[async]`, 01_SDK_MAP §2). The range fields
 * are the parameter's INTERNAL units via sync getters.
 */
export async function paramInfo(param: DeviceParameter<V>, id: ParamId): Promise<DeviceParamInfo> {
  const value = await param.getValue();
  return {
    id,
    name: param.name,
    min: param.min,
    max: param.max,
    isQuantized: param.isQuantized,
    defaultValue: param.defaultValue,
    value,
  };
}

/**
 * Map a live {@link Device} to a {@link DeviceInfo} with all its parameters. ASYNC
 * because each parameter's value is read with `getValue()`; the reads run in parallel
 * with `Promise.all` (order preserved, so the param ids line up with their index).
 */
export async function deviceInfo(
  device: Device<V>,
  trackIndex: number,
  deviceIndex: number,
): Promise<DeviceInfo> {
  const parameters = await Promise.all(
    device.parameters.map((param, index) =>
      paramInfo(param, paramId(trackIndex, deviceIndex, index)),
    ),
  );
  return { id: deviceId(trackIndex, deviceIndex), name: device.name, parameters };
}

/**
 * Map a track's {@link TrackMixer} to a {@link TrackMixerInfo}: its volume as an
 * addressable {@link DeviceParamInfo} whose id is `track:N/mixer/volume`, so Gain Stage
 * Doctor can write the trim through `setParam`. ASYNC for the volume's `getValue()`.
 */
export async function trackMixerInfo(
  mixer: TrackMixer<V>,
  trackIndex: number,
): Promise<TrackMixerInfo> {
  const volume = await paramInfo(mixer.volume, mixerVolumeParamId(trackIndex));
  return { volume };
}

/**
 * Build the minimal {@link MixerInfo} a {@link TrackInfo} carries. ASYNC because the
 * volume and pan scalars are parameter values (`getValue()`); `sendCount` is the length
 * of the sync `sends` getter.
 */
export async function mixerInfo(mixer: TrackMixer<V>): Promise<MixerInfo> {
  const [volume, panning] = await Promise.all([mixer.volume.getValue(), mixer.panning.getValue()]);
  return { volume, panning, sendCount: mixer.sends.length };
}

// --- scenes / cue points ---

/**
 * Map a live {@link Scene} to a {@link SceneInfo}. All getters are sync. The DTO models
 * "no Set-tempo override" as `null`, but the SDK's `Scene.tempo` always returns a
 * number, so a scene reports its effective tempo here (a faithful read of the surface).
 */
export function sceneInfo(scene: Scene<V>, index: number): SceneInfo {
  return {
    id: sceneId(index),
    name: scene.name,
    tempo: scene.tempo,
    signatureNumerator: scene.signatureNumerator,
    signatureDenominator: scene.signatureDenominator,
  };
}

/**
 * Build a {@link CuePointInfo} from a cue point's beat time + name and its index in
 * `song.cuePoints`. The cue point's own getters (`time`, `name`) are sync.
 */
export function cuePointInfo(index: number, time: number, name: string): CuePointInfo {
  return { id: cuePointId(index), time, name };
}
