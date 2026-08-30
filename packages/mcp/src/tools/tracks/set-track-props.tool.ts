/**
 * Tool 6 — `live_set_track_props` (write).
 *
 * Rename / mute / solo / arm a track, batching all provided properties into ONE
 * undo step. Only the keys present are written. At least one property must be
 * given (an empty patch is a clean `BAD_INPUT` via `.refine`).
 */

import { z } from 'zod';

import type { TrackPropsPatch } from '@othmanadi/loophole-core';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { TrackReference } from '../../schemas/primitives.js';

const inputSchema = z
  .object({
    trackId: TrackReference,
    props: z
      .object({
        name: z.string().min(1).optional().describe('New track name'),
        mute: z.boolean().optional(),
        solo: z.boolean().optional(),
        arm: z.boolean().optional().describe('Arm the track for recording'),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, 'Provide at least one property'),
  })
  .strict();

export const setTrackPropsTool = defineTool({
  name: 'live_set_track_props',
  title: 'Set track properties',
  description:
    "Set a current track reference's name, mute, solo, and / or arm in ONE undo step. Provide at least one " +
    'property; only the given keys are written. Returns the post-write track state. Use the ' +
    'track reference from live_find_track or live_get_song_overview.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    // Cast as for set-notes: Zod's optional fields are `T | undefined`, core's
    // TrackPropsPatch omits absent keys; the runtime value is a sound subset.
    const track = await bridge.setTrackProps(args.trackId, args.props as TrackPropsPatch);
    const data = {
      id: track.id,
      name: track.name,
      mute: track.mute,
      solo: track.solo,
      arm: track.arm,
    };
    return ok(data, 'Updated the referenced track.');
  },
});
