/**
 * Loophole Bridge: public surface of the `@othmanadi/ableton-mcp` package.
 *
 * Wave W0 ships the code seam only: the `LiveBridge` port, its in-memory
 * `FakeLiveBridge`, the serializable DTOs, the stable path-id scheme, the typed
 * error model, and the pure note transforms. No MCP server and no Ableton SDK call
 * exist yet (those land in later waves), so this file deliberately does NOT import
 * `@modelcontextprotocol/sdk`.
 */

// The seam: port + fake.
export type { LiveBridge } from './bridge/LiveBridge.js';
export { FakeLiveBridge } from './bridge/FakeLiveBridge.js';

// Serializable DTOs carried across the (future) MCP wire.
export type {
  ClipInfo,
  ClipLocation,
  ClipSlotInfo,
  CreateMidiClipArgs,
  CuePointInfo,
  DeviceInfo,
  DeviceParamInfo,
  MixerInfo,
  NoteDTO,
  SceneInfo,
  SongOverview,
  TrackInfo,
  TrackKind,
  TrackPropsPatch,
  TrackQuery,
} from './bridge/dtos.js';

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
} from './bridge/ids.js';
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
} from './bridge/ids.js';

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
} from './bridge/errors.js';
export type { BridgeErrorCode } from './bridge/errors.js';

// Pure domain transforms.
export {
  clampPitch,
  humanizeTiming,
  MAX_PITCH,
  MIN_PITCH,
  transposeNotes,
} from './domain/notes.js';
