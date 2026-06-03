/**
 * Tool 9 — `live_create_midi_clip` (write).
 *
 * Create an empty MIDI clip in a Session clip slot, ready for live_set_notes. One
 * queued transaction = one undo. Targets Session slots only (arrangement-clip
 * creation is out of scope this wave); the slot must be on a MIDI track and empty
 * (02_BRIDGE_SPEC §5 tool 9).
 */

import { z } from 'zod';

import { makePathId } from '@othmanadi/loophole-core';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { SlotId } from '../../schemas/primitives.js';

const inputSchema = z
  .object({
    slotId: SlotId,
    lengthBeats: z.number().min(0.25).describe('Clip length in beats, minimum 0.25'),
  })
  .strict();

export const createMidiClipTool = defineTool({
  name: 'live_create_midi_clip',
  title: 'Create MIDI clip',
  description:
    'Create an empty MIDI clip in a Session clip slot (given a length in beats, minimum 0.25), ' +
    'ready for live_set_notes. One undo step. The slot id must be an empty slot on a MIDI track ' +
    '(from live_list_clips). Returns the new clip id and slot id.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    // Not idempotent: a second call targets an occupied slot and is rejected.
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    const slotId = makePathId(args.slotId);
    const clip = await bridge.createMidiClip(slotId, args.lengthBeats);
    const data = {
      clipId: clip.id,
      slotId: clip.slotId ?? slotId,
      lengthBeats: clip.duration,
    };
    return ok(
      data,
      `Created MIDI clip ${clip.id} (${String(clip.duration)} beats). Add notes with ` +
        `live_set_notes using this clip id.`,
    );
  },
});
