/**
 * `@othmanadi/loophole-core`: the SDK-free, CI-tested heart shared by the Loophole
 * Bridge (`packages/mcp`) and the Loophole Kit extensions (`packages/extension`).
 *
 * It ships the code seam only: the `LiveBridge` port, its in-memory
 * `FakeLiveBridge`, the serializable DTOs, the stable path-id scheme, the typed
 * error model, and the pure note transforms. It imports NEITHER
 * `@modelcontextprotocol/sdk` NOR `@ableton-extensions/sdk`: the MCP server lives in
 * the bridge, and the one SDK-touching adapter lives in the extension. This package
 * is source-only (consumers bundle `src`), private, and never published.
 */

// The seam: port + fake.
export type { LiveBridge } from './live-bridge.js';
export { FakeLiveBridge } from './fake-live-bridge.js';

// Serializable DTOs carried across the MCP wire.
export type {
  ClipEntryKind,
  ClipInfo,
  ClipLocation,
  ClipSlotInfo,
  CreateAudioClipArgs,
  CreateMidiClipArgs,
  CuePointInfo,
  DeviceInfo,
  DeviceParamInfo,
  GridInfo,
  MixerInfo,
  NoteDTO,
  RenderResult,
  ScaleInfo,
  SceneInfo,
  SetNotesResult,
  SongOverview,
  TrackInfo,
  TrackKind,
  TrackMatch,
  TrackMixerInfo,
  TrackPropsPatch,
  TrackQuery,
  TrackRef,
} from './dtos.js';

// Transform input/output types (Wave B, stage 2): the shapes the five pure
// transforms consume and produce. Defined in core so stage-2 agents implement only
// functions and never edit a shared file.
export type {
  Fix,
  FixKind,
  HumanizeOpts,
  Issue,
  IssueId,
  IssueKind,
  LoudnessResult,
  MixerParam,
  Placement,
  PlanResult,
  Scale,
  SceneDTO,
  Section,
  SessionClipDTO,
  SessionDTO,
  SetClipDTO,
  SetDTO,
  SetTrackDTO,
  SnapMode,
  TimeSig,
} from './dtos.js';

// Stable string path ids (handles never cross this boundary).
export {
  arrangementClipId,
  buildPath,
  clipSlotId,
  cuePointId,
  deviceId,
  leafKind,
  leafSegment,
  makePathId,
  mixerVolumeParamId,
  paramId,
  parsePath,
  PathIdParseError,
  returnTrackId,
  sceneId,
  sessionClipId,
  trackId,
  tryParsePath,
} from './ids.js';
export type {
  ClipId,
  ClipSegmentKind,
  ClipSlotId,
  CuePointId,
  DeviceId,
  IndexedSegmentKind,
  MixerSegmentKind,
  ParamId,
  PathId,
  PathSegment,
  SceneId,
  SegmentKind,
  TrackId,
} from './ids.js';

// Typed error model + recovery hints.
export {
  badInput,
  BridgeError,
  isBridgeError,
  isBridgeErrorOfCode,
  sdkRejected,
  staleReference,
  unsupported,
  wrongType,
} from './errors.js';
export type { BridgeErrorCode } from './errors.js';

// Pure domain transforms.
export {
  clampPitch,
  clampVelocity,
  humanizeTiming,
  mapClipNotes,
  MAX_PITCH,
  MAX_VELOCITY,
  MIN_PITCH,
  MIN_VELOCITY,
  transposeNotes,
} from './transforms/notes.js';

// Pure extension transforms (Wave B): the SDK-free heart of each of the five
// extensions. Plain data in, plain data out; the handlers below wrap these.

// Scale Lock (W1).
export { snapToScale } from './transforms/scale.js';
export type { SnapResult } from './transforms/scale.js';

// Humanize / Groove Sculptor (W2). `humanize` takes an INJECTED rng for determinism.
export {
  gridInfoFrom,
  humanize,
  MAX_HUMANIZED_VELOCITY,
  MIN_HUMANIZED_VELOCITY,
} from './transforms/groove.js';

// Gain Stage Doctor (W3) loudness math.
export {
  analyzeLoudness,
  ASSUMED_DB_FROM_MIN_TO_UNITY,
  dbToParamValue,
  SILENCE_FLOOR_DB,
  suggestTrimDb,
} from './transforms/loudness.js';

// Session-to-Song Builder (W5) arrangement planner.
export { beatsPerBar, planArrangement } from './transforms/arrangement.js';

// Set Janitor (W6) hygiene rules.
export { DEFAULT_CLIP_PALETTE, detectIssues, planFixes } from './transforms/janitor.js';

// Command handlers (Wave B): the thin read-map-write glue between the LiveBridge port
// and the pure transforms above, each running every mutation in ONE transaction (one
// undo). SDK-free, so they run against FakeLiveBridge (ring 2) and the real adapter.

// Scale Lock (W1).
export { runScaleLock } from './handlers/scale-lock.js';
export type { ScaleLockArgs, ScaleLockResult } from './handlers/scale-lock.js';

// Humanize / Groove Sculptor (W2). `runHumanize` threads an INJECTED rng through.
export { runHumanize } from './handlers/humanize.js';
export type { HumanizeArgs } from './handlers/humanize.js';

// Gain Stage Doctor (W3). `runGainStageDoctor` takes an INJECTED `DecodeWav` callback,
// so core never imports `node:fs` or an audio-decode package.
export { runGainStageDoctor } from './handlers/gain-stage-doctor.js';
export type {
  DecodeWav,
  GainStageDoctorArgs,
  GainStageDoctorResult,
  GainStageRow,
} from './handlers/gain-stage-doctor.js';

// Session-to-Song Builder (W5).
export { runSessionToSong } from './handlers/session-to-song.js';
export type { SessionToSongArgs, SessionToSongResult } from './handlers/session-to-song.js';

// Set Janitor (W6).
export { runSetJanitor } from './handlers/set-janitor.js';
export type { SetJanitorArgs, SetJanitorResult } from './handlers/set-janitor.js';
