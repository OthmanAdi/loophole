/**
 * Public object identifiers used by the SDK-free core.
 *
 * These aliases deliberately expose only opaque, session-scoped references. Positional
 * Live object paths are an adapter-private implementation detail and must never cross
 * this package boundary.
 */

import type {
  ClipReference,
  ClipSlotReference,
  CuePointReference,
  DeviceReference,
  ParameterReference,
  SceneReference,
  TrackReference,
} from './references.js';

export type TrackId = TrackReference;
export type ClipId = ClipReference;
export type ClipSlotId = ClipSlotReference;
export type SceneId = SceneReference;
export type DeviceId = DeviceReference;
export type ParamId = ParameterReference;
export type CuePointId = CuePointReference;
