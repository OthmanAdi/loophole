/**
 * Shared Zod v4 schema atoms: the building blocks every tool input reuses so
 * that ids, beats, pitch, and the note shape are identical across all 12 tools
 * (02_BRIDGE_SPEC §5.0).
 *
 * Each atom carries a `.describe(...)` so the description surfaces in the tool's
 * published JSON Schema and the model knows the units and the source of an id.
 * `NoteSchema` is `.strict()` (no unknown keys) and mirrors the SDK's
 * `NoteDescription` and core's `NoteDTO`: `pitch`/`startTime`/`duration`
 * required, the rest optional and omitted (never `undefined`) when absent.
 */

import { z } from 'zod';

/** MIDI pitch, 0..127. */
export const Pitch = z.number().int().min(0).max(127).describe('MIDI pitch 0-127');

/** MIDI velocity, 0..127 (allowed fractional to match the SDK's bare `number`). */
export const Velocity = z.number().min(0).max(127).describe('MIDI velocity 0-127');

/** A position or length in beats (non-negative). */
export const Beats = z.number().min(0).describe('Position or length in beats');

/** A stable track id from `live_find_track` / `live_get_song_overview`. */
export const TrackId = z
  .string()
  .min(1)
  .describe("Stable track id from live_find_track / overview, e.g. 'track:2'");

/** A stable clip id from `live_list_clips`. */
export const ClipId = z
  .string()
  .min(1)
  .describe("Stable clip id from live_list_clips, e.g. 'track:2/clipslot:4/clip'");

/** A stable clip-slot id from `live_list_clips`. */
export const SlotId = z
  .string()
  .min(1)
  .describe("Stable clip-slot id from live_list_clips, e.g. 'track:2/clipslot:4'");

/** A stable device-parameter id (from a track's device/param list). */
export const ParamId = z
  .string()
  .min(1)
  .describe("Stable parameter id, e.g. 'track:2/device:1/param:6'");

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
