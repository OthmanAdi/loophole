/**
 * Shared Zod v4 schema atoms: the building blocks every tool input reuses so
 * that references, beats, pitch, and the note shape are identical across all 12 tools
 * (02_BRIDGE_SPEC §5.0).
 *
 * Each atom carries a `.describe(...)` so the description surfaces in the tool's
 * published JSON Schema and the model knows the units and the source of a reference.
 * `NoteSchema` is `.strict()` (no unknown keys) and mirrors the SDK's
 * `NoteDescription` and core's `NoteDTO`: `pitch`/`startTime`/`duration`
 * required, the rest optional and omitted (never `undefined`) when absent.
 */

import {
  type ClipReference as CoreClipReference,
  type ClipSlotReference as CoreClipSlotReference,
  type CuePointReference as CoreCuePointReference,
  type DeviceReference as CoreDeviceReference,
  type ParameterReference as CoreParameterReference,
  type SceneReference as CoreSceneReference,
  type SessionReferenceKind,
  type TrackReference as CoreTrackReference,
} from '@othmanadi/loophole-core';
import { z } from 'zod';

/** MIDI pitch, 0..127. */
export const Pitch = z.number().int().min(0).max(127).describe('MIDI pitch 0-127');

/** MIDI velocity, 0..127 (allowed fractional to match the SDK's bare `number`). */
export const Velocity = z.number().min(0).max(127).describe('MIDI velocity 0-127');

/** A position or length in beats (non-negative). */
export const Beats = z.number().min(0).describe('Position or length in beats');

/**
 * One strict, type-tagged opaque reference. The wire never accepts positional
 * paths: callers must first obtain an `lhref_*` value from a read/list response.
 */
function opaqueReference<K extends SessionReferenceKind, R extends string>(
  kind: K,
  description: string,
): z.ZodType<R> {
  // Zod custom schemas cannot be emitted as MCP JSON Schema. Keep validation
  // fully representable for `tools/list` with the exact wire regex, then retain
  // the core brand only at TypeScript's compile-time boundary.
  return z
    .string()
    .regex(
      new RegExp(`^lhref_${referenceTag(kind)}_[A-Za-z0-9_-]{16,128}$`),
      `Expected a live ${kind} reference (lhref_${referenceTag(kind)}_<opaque-token>).`,
    )
    .describe(description) as unknown as z.ZodType<R>;
}

function referenceTag(kind: SessionReferenceKind): string {
  const tags: Readonly<Record<SessionReferenceKind, string>> = {
    track: 'trk',
    scene: 'scn',
    'cue-point': 'cue',
    'clip-slot': 'slot',
    clip: 'clip',
    device: 'dev',
    parameter: 'param',
  };
  return tags[kind];
}

/** A track capability returned by `live_find_track` / `live_get_song_overview`. */
export const TrackReference = opaqueReference<'track', CoreTrackReference>(
  'track',
  'Opaque track reference from a current live read, formatted lhref_trk_<opaque-token>.',
);

/** A clip capability returned by `live_list_clips`. */
export const ClipReference = opaqueReference<'clip', CoreClipReference>(
  'clip',
  'Opaque clip reference from a current live read, formatted lhref_clip_<opaque-token>.',
);

/** A clip-slot capability returned by `live_list_clips`. */
export const ClipSlotReference = opaqueReference<'clip-slot', CoreClipSlotReference>(
  'clip-slot',
  'Opaque clip-slot reference from a current live read, formatted lhref_slot_<opaque-token>.',
);

/** A device capability returned by a current track resource. */
export const DeviceReference = opaqueReference<'device', CoreDeviceReference>(
  'device',
  'Opaque device reference from a current live read, formatted lhref_dev_<opaque-token>.',
);

/** A parameter capability returned by a current track resource or insert result. */
export const ParameterReference = opaqueReference<'parameter', CoreParameterReference>(
  'parameter',
  'Opaque parameter reference from a current live read, formatted lhref_param_<opaque-token>.',
);

/** A scene capability returned by a current live read. */
export const SceneReference = opaqueReference<'scene', CoreSceneReference>(
  'scene',
  'Opaque scene reference from a current live read, formatted lhref_scn_<opaque-token>.',
);

/** A cue-point capability returned by a current live read. */
export const CuePointReference = opaqueReference<'cue-point', CoreCuePointReference>(
  'cue-point',
  'Opaque cue-point reference from a current live read, formatted lhref_cue_<opaque-token>.',
);

/**
 * One MIDI note on the wire. Mirrors core's `NoteDTO` / the SDK's
 * `NoteDescription`: the three required fields plus the optional groove fields.
 * `.strict()` rejects unknown keys so a malformed note is a clean `BAD_INPUT`,
 * not a silently-dropped field.
 */
export const NoteSchema = z
  .object({
    pitch: Pitch,
    startTime: Beats,
    duration: Beats,
    velocity: Velocity.optional(),
    muted: z.boolean().optional(),
    probability: z.number().min(0).max(1).optional().describe('Playback probability 0-1'),
    velocityDeviation: z.number().optional().describe('Per-note velocity randomization range'),
    releaseVelocity: Velocity.optional().describe('Note-off velocity 0-127'),
    selected: z.boolean().optional(),
  })
  .strict();
