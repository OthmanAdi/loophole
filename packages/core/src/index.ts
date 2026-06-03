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
  TrackPropsPatch,
  TrackQuery,
  TrackRef,
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
