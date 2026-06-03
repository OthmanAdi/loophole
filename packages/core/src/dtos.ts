/**
 * Plain, serializable Data Transfer Objects returned across the MCP wire.
 *
 * These are the shapes the tool layer and, eventually, the MCP client see. They are
 * pure JSON: numbers, strings, booleans, arrays, and nested DTOs. No Ableton SDK
 * type, no `Handle`, and no `bigint` ever leaks into this file. Object references
 * are carried as string {@link PathId}s, never as host handles.
 *
 * The DTO field names mirror the SDK surface in API_REFERENCE.md so the mapping in
 * the `AbletonLiveBridge` adapter stays a near-mechanical translation.
 */

import type { ClipId, ClipSlotId, CuePointId, DeviceId, ParamId, SceneId, TrackId } from './ids.js';

/** A track is one of these two concrete kinds in the SDK. */
export type TrackKind = 'audio' | 'midi';

/** Where a clip lives: a Session-view clip slot or the Arrangement timeline. */
export type ClipLocation = 'session' | 'arrangement';

/**
 * What a {@link ClipInfo} entry from {@link import("./live-bridge.js").LiveBridge.listClips}
 * represents: a MIDI clip, an audio clip, or an empty Session clip slot (so the
 * model can see where it may create a clip). `'empty'` entries carry a
 * {@link ClipInfo.slotId} and have no notes.
 */
export type ClipEntryKind = 'midi' | 'audio' | 'empty';

/**
 * One MIDI note, mirroring the SDK's `NoteDescription`.
 *
 * Required fields are always present; optional fields follow `NoteDescription`
 * exactly and are omitted (not set to `undefined`) when the host does not report
 * them, matching `exactOptionalPropertyTypes`. `startTime` and `duration` are in
 * beats; `pitch` and the velocities are MIDI values in 0..127.
 */
export interface NoteDTO {
  /** MIDI pitch, 0..127. */
  readonly pitch: number;
  /** Start position in beats, relative to the clip. */
  readonly startTime: number;
  /** Length in beats. */
  readonly duration: number;
  /** Note-on velocity, 0..127. */
  readonly velocity?: number;
  readonly muted?: boolean;
  /** Playback probability, 0..1. */
  readonly probability?: number;
  /** Per-note velocity randomization range. */
  readonly velocityDeviation?: number;
  /** Note-off velocity, 0..127. */
  readonly releaseVelocity?: number;
  readonly selected?: boolean;
}

/**
 * One entry in {@link SongOverview.tracks}: the minimum a model needs to address a
 * track in a follow-up call. Mirrors the `live_get_song_overview` track list, which
 * pairs each human name with the stable id and concrete kind.
 */
export interface TrackRef {
  readonly id: TrackId;
  readonly name: string;
  /** Concrete track kind, surfaced as `type` to match the tool output naming. */
  readonly type: TrackKind;
}

/**
 * The Set's scale state, lifted out of {@link SongOverview} so Scale Lock and the
 * overview tool share one shape. Root note is a pitch class 0..11 (C..B), and the
 * intervals are semitone offsets from the root that define scale membership.
 */
export interface ScaleInfo {
  /** Root note of the Set scale, 0..11 (C..B). */
  readonly rootNote: number;
  readonly scaleName: string;
  /** Whether Live's Scale Mode is enabled. */
  readonly scaleMode: boolean;
  /** Semitone offsets that define the current scale. */
  readonly scaleIntervals: readonly number[];
}

/** The Set's grid quantization state, surfaced in the overview snapshot. */
export interface GridInfo {
  /** Live's grid quantization label (e.g. the value of `song.gridQuantization`). */
  readonly quantization: string;
  readonly isTriplet: boolean;
}

/**
 * High-level snapshot of the Live Set. A summary, not a full dump: it carries the
 * small scalar song properties, the object counts, and a flat list of tracks with
 * ids so the model can orient and drill down without a second read. Per-clip and
 * per-device detail is left to {@link ClipInfo} and {@link DeviceParamInfo} reads.
 */
export interface SongOverview {
  /** Tempo in BPM. */
  readonly tempo: number;
  /** Root note of the Set scale, 0..11 (C..B). */
  readonly rootNote: number;
  readonly scaleName: string;
  readonly scaleMode: boolean;
  /** Semitone offsets that define the current scale. */
  readonly scaleIntervals: readonly number[];
  /** Live's grid quantization label. */
  readonly gridQuantization: string;
  readonly gridIsTriplet: boolean;
  /** Number of non-return, non-main tracks. */
  readonly trackCount: number;
  readonly returnTrackCount: number;
  readonly sceneCount: number;
  readonly cuePointCount: number;
  /** The non-return, non-main tracks, each with its id, name, and kind. */
  readonly tracks: readonly TrackRef[];
}

/** Mixer summary for a track (volume / pan as current scalar values, 0..1-ish). */
export interface MixerInfo {
  /** Current volume parameter value. */
  readonly volume: number;
  /** Current panning parameter value. */
  readonly panning: number;
  /** Number of send parameters on this track. */
  readonly sendCount: number;
}

/** A track and its current state, addressed by a stable {@link TrackId}. */
export interface TrackInfo {
  readonly id: TrackId;
  readonly kind: TrackKind;
  readonly name: string;
  readonly mute: boolean;
  readonly solo: boolean;
  readonly mutedViaSolo: boolean;
  readonly arm: boolean;
  /** Number of Session-view clip slots on this track. */
  readonly clipSlotCount: number;
  /** Number of clips on the Arrangement timeline for this track. */
  readonly arrangementClipCount: number;
  /** Number of devices in this track's chain. */
  readonly deviceCount: number;
  readonly mixer: MixerInfo;
}

/**
 * A track match from {@link import("./live-bridge.js").LiveBridge.findTrack}: the
 * minimal `{ name, id, type }` triple the model needs to disambiguate and then
 * address a track. `type` is the concrete track kind.
 */
export interface TrackMatch {
  readonly id: TrackId;
  readonly name: string;
  readonly type: TrackKind;
}

/**
 * One entry from {@link import("./live-bridge.js").LiveBridge.listClips}: either a
 * clip (audio or MIDI) or an empty Session clip slot.
 *
 * - For a clip, `id` is the clip id (`sessionClipId` or `arrangementClipId`),
 *   `kind` is `'midi'` or `'audio'`, and the geometry fields describe the clip.
 *   Session clips additionally carry their parent {@link ClipInfo.slotId}.
 * - For an empty Session slot, `kind` is `'empty'`, `id` and `slotId` are the slot
 *   id, `isMidi` is `false`, `name` is empty, and the geometry fields are zero. The
 *   model reads these to know where it can create a clip.
 */
export interface ClipInfo {
  readonly id: ClipId;
  /** Whether the clip is a MIDI clip (so `getNotes` / `setNotes` apply). */
  readonly isMidi: boolean;
  /** Clip kind, or `'empty'` for an empty Session clip slot. */
  readonly kind: ClipEntryKind;
  readonly location: ClipLocation;
  /** The parent clip-slot id, present for Session clips and empty slots. */
  readonly slotId?: ClipSlotId;
  readonly name: string;
  /** Start position in beats. */
  readonly startTime: number;
  /** End position in beats. */
  readonly endTime: number;
  /** Length in beats. */
  readonly duration: number;
  readonly looping: boolean;
  readonly loopStart: number;
  readonly loopEnd: number;
  /** Live's numeric color value. */
  readonly color: number;
  readonly muted: boolean;
}

/** A Session-view clip slot and whether it currently holds a clip. */
export interface ClipSlotInfo {
  readonly id: ClipSlotId;
  /** The clip in this slot, or `null` if the slot is empty. */
  readonly clip: ClipInfo | null;
}

/** A device parameter snapshot (value is the current value, not a Promise). */
export interface DeviceParamInfo {
  readonly id: ParamId;
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly isQuantized: boolean;
  readonly defaultValue: number;
  /** Current value (the adapter awaits `getValue()` before building this DTO). */
  readonly value: number;
}

/** A device on a track and its parameters, addressed by a {@link DeviceId}. */
export interface DeviceInfo {
  readonly id: DeviceId;
  readonly name: string;
  readonly parameters: readonly DeviceParamInfo[];
}

/** A Session/Arrangement scene summary. */
export interface SceneInfo {
  readonly id: SceneId;
  readonly name: string;
  /** Scene tempo, or `null` when the scene does not override the Set tempo. */
  readonly tempo: number | null;
  readonly signatureNumerator: number;
  readonly signatureDenominator: number;
}

/** An Arrangement cue point (marker). */
export interface CuePointInfo {
  readonly id: CuePointId;
  /** Position in beats. */
  readonly time: number;
  readonly name: string;
}

/**
 * Properties that {@link import("./live-bridge.js").LiveBridge.setTrackProps} can
 * write. Mirrors the SDK's writable track fields (`name`, `mute`, `solo`, `arm`).
 * Every field is optional: only the keys present are applied. Omitted keys are not
 * set to `undefined` (per `exactOptionalPropertyTypes`).
 */
export interface TrackPropsPatch {
  readonly name?: string;
  readonly mute?: boolean;
  readonly solo?: boolean;
  readonly arm?: boolean;
}

/**
 * A structured track filter (name substring + kind). Not used by the current port
 * ({@link import("./live-bridge.js").LiveBridge.findTrack} takes a plain string); kept
 * as a forward-declared shape for richer multi-criteria queries in a later wave.
 */
export interface TrackQuery {
  /** Case-insensitive substring match against the track name. */
  readonly name?: string;
  /** Restrict to a track kind. */
  readonly kind?: TrackKind;
}

/**
 * Arguments for creating a MIDI clip on the Arrangement timeline (positional
 * `start` + `duration`, per `MidiTrack.createMidiClip`). Not used by the current
 * port ({@link import("./live-bridge.js").LiveBridge.createMidiClip} targets a Session
 * slot); kept as a forward-declared shape for arrangement-clip creation in a later
 * wave.
 */
export interface CreateMidiClipArgs {
  /** Target track. */
  readonly trackId: TrackId;
  /** Start position in beats. */
  readonly startTime: number;
  /** Length in beats (must be > 0). */
  readonly duration: number;
}

/**
 * Result of {@link import("./live-bridge.js").LiveBridge.setNotes}: the clip id, its
 * name, and the number of notes now in the clip after the wholesale replacement.
 */
export interface SetNotesResult {
  readonly id: ClipId;
  readonly name: string;
  readonly count: number;
}

/**
 * Result of {@link import("./live-bridge.js").LiveBridge.renderTrack}: the path to
 * the rendered WAV (in the extension temp directory) and the rendered track's name.
 */
export interface RenderResult {
  readonly path: string;
  readonly track: string;
}
