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

import type {
  ClipId,
  ClipSlotId,
  CuePointId,
  DeviceId,
  ParamId,
  PathId,
  SceneId,
  TrackId,
} from './ids.js';

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

/**
 * The Set's grid quantization state, surfaced in the overview snapshot and consumed
 * by Humanize (W2) to scale a nudge to "up to ± half a grid cell".
 *
 * `beatsPerCell` is the width of one grid cell in beats, DERIVED from the two raw
 * fields the {@link SongOverview} reports (`gridQuantization` + `gridIsTriplet`). It
 * is carried here so Humanize never has to parse the label string itself. The
 * mapping (one quarter note = 1 beat) is:
 *
 * | `quantization` | straight beats | × triplet (×2/3) |
 * |----------------|----------------|------------------|
 * | `'1/4'`        | `1`            | `0.6666…`        |
 * | `'1/8'`        | `0.5`          | `0.3333…`        |
 * | `'1/16'`       | `0.25`         | `0.1666…`        |
 * | `'1/32'`       | `0.125`        | `0.0833…`        |
 *
 * In general `beatsPerCell = (4 / denominator) * (isTriplet ? 2 / 3 : 1)`, where
 * `denominator` is the number under the `1/` in the label. When Live reports a grid
 * label this code does not recognise (e.g. `'None'`), the derivation falls back to a
 * sane default of one beat (a quarter-note cell); the stage-2 handler decides
 * whether to apply Humanize at all in that case.
 */
export interface GridInfo {
  /** Live's grid quantization label (e.g. the value of `song.gridQuantization`). */
  readonly quantization: string;
  readonly isTriplet: boolean;
  /**
   * Width of one grid cell in beats (one quarter note = 1 beat). Derived from
   * `quantization` + `isTriplet` per the mapping documented on this interface.
   */
  readonly beatsPerCell: number;
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
  /**
   * Clip content end marker in beats (mirrors `Clip.endMarker`, a read-only SDK
   * getter). For a looping clip, `endMarker > loopEnd` means the written content
   * extends past the loop brace (the playback loops before the content ends); Set
   * Janitor's loop-overrun rule compares the two. For an empty Session slot this is
   * `0` (there is no content). Always present so the loop-overrun rule is not blind
   * through the port.
   */
  readonly endMarker: number;
  /** Live's numeric color value. */
  readonly color: number;
  readonly muted: boolean;
  /**
   * Absolute path to the source audio file, present ONLY for audio clips (mirrors
   * `AudioClip.filePath`). Omitted for MIDI clips and empty slots
   * (`exactOptionalPropertyTypes`: a missing key, never `filePath: undefined`).
   * Session-to-Song (W5) reads this to reference an audio clip by file when it
   * recreates the clip on the Arrangement timeline.
   */
  readonly filePath?: string;
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

/**
 * Arguments for creating an audio clip on the Arrangement timeline by file
 * reference, mirroring `AudioTrack.createAudioClip({ filePath, startTime, duration })`
 * (01_SDK_MAP §2). `startTime` is the arrangement position in beats and `duration`
 * is the clip length in beats. Used by
 * {@link import("./live-bridge.js").LiveBridge.createArrangementAudioClip} so
 * Session-to-Song can reference an audio clip by its source file.
 */
export interface CreateAudioClipArgs {
  /** Absolute path to the source audio file (mirrors `AudioClip.filePath`). */
  readonly filePath: string;
  /** Arrangement position in beats. */
  readonly startTime: number;
  /** Clip length in beats (must be > 0). */
  readonly duration: number;
}

/**
 * The single writable mixer parameter Gain Stage Doctor (W3) cares about: the
 * track's volume, as a {@link DeviceParamInfo} carrying a stable {@link ParamId}.
 *
 * Result of {@link import("./live-bridge.js").LiveBridge.getTrackMixer}. The handler
 * reads `volume.min` / `volume.max` / `volume.defaultValue` / `volume.value` to fit
 * the dB-to-internal mapping, then writes the new value through
 * {@link import("./live-bridge.js").LiveBridge.setParam} using `volume.id`. Exposing
 * the volume as an addressable parameter (rather than a bare number) is what lets
 * the existing one-undo `setParam` path drive the mixer with no new write method.
 */
export interface TrackMixerInfo {
  /** The track's mixer volume, addressable by its {@link ParamId} via `setParam`. */
  readonly volume: DeviceParamInfo;
}

// ===========================================================================
// Transform input/output types (Wave B, stage 2).
//
// The shapes the five pure transforms consume and produce. They are defined here
// so the stage-2 agents only implement functions and never touch a shared file.
// All are plain and handle-free; object references are carried as string PathIds.
// Each is grounded in a section of 03_EXTENSIONS_SPEC; section refs are inline.
// ===========================================================================

// --- Scale Lock (W1), 03_EXTENSIONS_SPEC §1 ---

/**
 * The direction `snapToScale` moves an off-scale note: to the next in-scale pitch
 * `'up'`, the previous one `'down'`, or whichever is closer `'nearest'` (the UI
 * default). 03_EXTENSIONS_SPEC §1(b)/§1(c).
 */
export type SnapMode = 'up' | 'down' | 'nearest';

/**
 * The minimal scale `snapToScale` needs: a root pitch class and the in-scale
 * semitone offsets from it. This is the handle-free transform input the handler
 * builds from the Set's scale state ({@link ScaleInfo} / {@link SongOverview}):
 * `{ root: overview.rootNote, intervals: overview.scaleIntervals }`. Kept separate
 * from {@link ScaleInfo} (which also carries the display name and Scale-Mode flag)
 * so the pure function takes only what it uses, per 03_EXTENSIONS_SPEC §0/§1(b)
 * (`snapToScale(notes, { root, intervals }, mode)`).
 */
export interface Scale {
  /** Root note as a pitch class 0..11 (C..B). */
  readonly root: number;
  /** In-scale semitone offsets from the root (e.g. major = `[0,2,4,5,7,9,11]`). */
  readonly intervals: readonly number[];
}

// --- Humanize / Groove Sculptor (W2), 03_EXTENSIONS_SPEC §2 ---

/**
 * Options for `humanize`, mapped one-to-one from the Humanize modal
 * (03_EXTENSIONS_SPEC §2(c)). `strength` and `swing` are 0..1 fractions (the UI
 * shows 0-100%); `strength` 0 is an identity transform (§2(f)). The three `do*`
 * flags gate which `NoteDescription` fields are nudged; `living`, when set, also
 * writes `probability` / `velocityDeviation` for a less mechanical feel (§2(b)).
 */
export interface HumanizeOpts {
  /** Overall amount, 0..1 (UI 0-100%). At 0, `humanize` returns its input unchanged. */
  readonly strength: number;
  /** Optional swing amount, 0..1 (UI 0-100%); delays off-beat positions. */
  readonly swing?: number;
  /** Nudge note `startTime` (scaled to the grid cell). */
  readonly doTiming: boolean;
  /** Vary note `velocity` (result clamped to 1..127). */
  readonly doVelocity: boolean;
  /** Jitter note `duration`. */
  readonly doDuration: boolean;
  /** Also write `probability` / `velocityDeviation` for a "living" pattern. */
  readonly living?: boolean;
}

// --- Gain Stage Doctor (W3), 03_EXTENSIONS_SPEC §3 ---

/**
 * Result of `analyzeLoudness(channels)`: the measured levels of a rendered audio
 * region (03_EXTENSIONS_SPEC §3(b)). `peakDb` is `max|sample|` in dBFS, `rmsDb` is
 * the RMS level in dBFS, and `crest` is the crest factor (`peakDb - rmsDb`, in dB).
 * Silence maps `peakDb`/`rmsDb` to a guarded floor rather than `-Infinity` (§3(f)).
 */
export interface LoudnessResult {
  /** True-peak level in dBFS (`max|sample|` → dB). */
  readonly peakDb: number;
  /** RMS level in dBFS. */
  readonly rmsDb: number;
  /** Crest factor in dB (`peakDb - rmsDb`). */
  readonly crest: number;
}

/**
 * The slice of a mixer-volume {@link DeviceParamInfo} that `dbToParamValue` maps a
 * dB delta onto (03_EXTENSIONS_SPEC §3(b)): the parameter's internal `min`, `max`,
 * and `defaultValue` (its unity point). A structural subset of
 * {@link DeviceParamInfo}, so a handler can pass the volume param straight in.
 */
export interface MixerParam {
  /** Internal minimum (raw units, not display). */
  readonly min: number;
  /** Internal maximum (raw units, not display). */
  readonly max: number;
  /** Internal value at unity gain (the parameter's default). */
  readonly defaultValue: number;
}

// --- Session-to-Song Builder (W5), 03_EXTENSIONS_SPEC §4 ---

/**
 * A musical time signature. The Set has no Set-level time signature in the SDK; it
 * lives on the {@link SceneDTO}, so `planArrangement` takes one explicitly and
 * defaults callers to 4/4 (03_EXTENSIONS_SPEC §4(b)/§4(d)).
 */
export interface TimeSig {
  /** Beats per bar (the numerator). */
  readonly num: number;
  /** Beat unit (the denominator: 4 = quarter, 8 = eighth). */
  readonly den: number;
}

/**
 * One Session clip as `planArrangement` sees it: handle-free, the source for a
 * recreated Arrangement clip. MIDI clips carry their `notes`; audio clips carry a
 * `filePath`. `clipRef` is the stable id of the source clip, echoed onto the
 * resulting {@link Placement.sourceClipRef} so the handler knows which clip to copy.
 * 03_EXTENSIONS_SPEC §4(b).
 */
export interface SessionClipDTO {
  /** Stable id of the source Session clip. */
  readonly clipRef: ClipId;
  /** Index of the owning track within {@link SessionDTO.tracks}. */
  readonly trackIndex: number;
  /** Index of the owning scene within {@link SessionDTO.scenes}. */
  readonly sceneIndex: number;
  readonly isMidi: boolean;
  readonly name: string;
  /** Live's numeric color value. */
  readonly color: number;
  /** Clip length in beats (the source loop length). */
  readonly durationBeats: number;
  /** MIDI notes, present for MIDI clips only (omitted for audio). */
  readonly notes?: readonly NoteDTO[];
  /** Source audio file path, present for audio clips only (omitted for MIDI). */
  readonly filePath?: string;
}

/** One Session scene as `planArrangement` sees it (handle-free). §4(b). */
export interface SceneDTO {
  /** Index of this scene within {@link SessionDTO.scenes}. */
  readonly index: number;
  readonly name: string;
  /**
   * The scene's time signature, when it overrides the Set; omitted when the scene
   * does not report one (the caller then falls back to the `planArrangement`
   * `timeSig` argument). 01_SDK_MAP §2 (`Scene.signatureNumerator/Denominator`).
   */
  readonly timeSig?: TimeSig;
}

/**
 * The whole Session as plain data, the input to `planArrangement`
 * (03_EXTENSIONS_SPEC §4(b)). Tracks are named/typed so a {@link Placement} can name
 * the lane; clips are flat and each tags its owning track + scene so the planner can
 * find "every track that has a clip in the mapped scene".
 */
export interface SessionDTO {
  readonly tracks: readonly TrackRef[];
  readonly scenes: readonly SceneDTO[];
  readonly clips: readonly SessionClipDTO[];
}

/**
 * One row of the user's section map: a named song section, the Session scene it is
 * built from, and its length in bars (03_EXTENSIONS_SPEC §4(c), e.g. "Intro 8,
 * Verse 16"). An optional color tints every clip placed for the section.
 */
export interface Section {
  readonly name: string;
  /** Index into {@link SessionDTO.scenes} of the scene this section is built from. */
  readonly sceneIndex: number;
  /** Section length in bars. */
  readonly bars: number;
  /** Optional color applied to the section's clips and used for its swatch. */
  readonly color?: number;
}

/**
 * One clip `planArrangement` decides to write onto the Arrangement timeline
 * (03_EXTENSIONS_SPEC §4(b)). The handler turns each into a create-then-populate on
 * the target track: `createArrangementMidiClip` / `createArrangementAudioClip` at
 * `startBeat` for `durationBeats`, then name + color from this DTO, copying the
 * source clip identified by `sourceClipRef`.
 */
export interface Placement {
  /** Target track index within the Set's track list. */
  readonly trackIndex: number;
  /** Arrangement start position in beats. */
  readonly startBeat: number;
  /** Clip length in beats. */
  readonly durationBeats: number;
  /** Stable id of the source Session clip to copy (notes for MIDI, file for audio). */
  readonly sourceClipRef: ClipId;
  /** Name to set on the placed clip. */
  readonly name: string;
  /** Optional color to set on the placed clip. */
  readonly color?: number;
}

/**
 * Output of `planArrangement` (03_EXTENSIONS_SPEC §0/§4(b)): the clips to place and
 * the section-boundary cue points to create. Both are plain data the handler then
 * writes inside one transaction.
 */
export interface PlanResult {
  readonly placements: readonly Placement[];
  readonly cuePoints: readonly { readonly beat: number; readonly name: string }[];
}

// --- Set Janitor (W6), 03_EXTENSIONS_SPEC §5 ---

/**
 * One track as `detectIssues` sees it (handle-free). Carries just what the rules
 * need: the stable id (so a {@link Fix} can target it), the name (placeholder-name
 * rule), whether it has any device (empty-track rule also checks clips), and its
 * clips. 03_EXTENSIONS_SPEC §5(b).
 */
export interface SetTrackDTO {
  readonly id: TrackId;
  readonly kind: TrackKind;
  readonly name: string;
  /** Number of devices in the track's chain (0 with no clips = empty track). */
  readonly deviceCount: number;
  readonly clips: readonly SetClipDTO[];
}

/**
 * One clip as `detectIssues` sees it (handle-free). 03_EXTENSIONS_SPEC §5(b): name
 * (placeholder rule), color (off-palette rule), and the loop geometry the loop-
 * overrun rule compares (`endMarker > loopEnd`).
 */
export interface SetClipDTO {
  readonly id: ClipId;
  readonly name: string;
  /** Live's numeric color value (checked against the palette). */
  readonly color: number;
  readonly looping: boolean;
  readonly loopStart: number;
  readonly loopEnd: number;
  /** Clip content end marker; `endMarker > loopEnd` flags a loop overrun. */
  readonly endMarker: number;
  /** Parent clip-slot id, present for Session clips (so a delete can target the slot). */
  readonly slotId?: ClipSlotId;
}

/**
 * The whole Set as plain data, the input to `detectIssues` (03_EXTENSIONS_SPEC
 * §5(b)). A flat track list, each track carrying its clips.
 */
export interface SetDTO {
  readonly tracks: readonly SetTrackDTO[];
}

/** The kinds of mess {@link Issue} flags. 03_EXTENSIONS_SPEC §5(a)/§5(b). */
export type IssueKind = 'emptyTrack' | 'placeholderName' | 'offPaletteColor' | 'loopOverrun';

/**
 * A stable id for one detected {@link Issue}, used to mark which issues the user
 * chose to fix when calling `planFixes(issues, chosen)`. 03_EXTENSIONS_SPEC §0/§5(b).
 */
export type IssueId = string;

/**
 * One problem `detectIssues` found (03_EXTENSIONS_SPEC §5(b)). `target` is the
 * handle-free id of the offending track or clip (a {@link TrackId} or {@link ClipId});
 * `detail` is a short human description for the checklist UI.
 */
export interface Issue {
  readonly id: IssueId;
  readonly kind: IssueKind;
  /** Id of the offending object (a track or clip path id). */
  readonly target: PathId;
  /** Short human-readable description of the issue. */
  readonly detail: string;
}

/** The kinds of repair {@link Fix} describes. 03_EXTENSIONS_SPEC §5(b). */
export type FixKind = 'rename' | 'recolor' | 'deleteTrack' | 'deleteClip';

/**
 * One repair `planFixes` emits for a chosen {@link Issue} (03_EXTENSIONS_SPEC §5(b)).
 * `target` is the object to change (a track or clip path id). `value` carries the new
 * name (`rename`) or color (`recolor`) and is absent for the destructive `deleteTrack`
 * / `deleteClip` kinds. The handler does the sync edits (`rename`/`recolor`) inline
 * and batches the async deletes, all in one transaction (§5(b)).
 */
export interface Fix {
  readonly kind: FixKind;
  /** Id of the object to change (a track or clip path id). */
  readonly target: PathId;
  /** New name for `rename`; absent for the other kinds. */
  readonly name?: string;
  /** New color for `recolor`; absent for the other kinds. */
  readonly color?: number;
}
