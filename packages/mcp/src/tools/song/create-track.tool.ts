/**
 * Tool 8 — `live_create_track` (write).
 *
 * Add one empty MIDI or audio track at the end of the track list. One queued
 * transaction = one undo. Naming is a SEPARATE call: the SDK cannot
 * create-then-configure in one transaction, so the model renames the new track
 * with live_set_track_props afterwards (02_BRIDGE_SPEC §4, §5 tool 8).
 */

import { z } from 'zod';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';

const inputSchema = z
  .object({
    kind: z.enum(['midi', 'audio']).describe('Track type to create'),
  })
  .strict();

export const createTrackTool = defineTool({
  name: 'live_create_track',
  title: 'Create track',
  description:
    'Create one empty MIDI or audio track at the end of the track list. One undo step. The ' +
    'track is unnamed; to name it, call live_set_track_props with the returned track id (the ' +
    'SDK cannot create and configure in a single undo step). Returns the new track id, name, ' +
    'and type.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    // Not idempotent: each call adds another track.
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    const track = await bridge.createTrack(args.kind);
    return ok(
      track,
      `Created ${track.kind} track ${track.name} (${track.id}). To name it, call ` +
        `live_set_track_props with this id.`,
    );
  },
});
