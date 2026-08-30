/**
 * Tool 9 — `live_create_midi_clip` (write).
 *
 * Create an empty MIDI clip in a Session clip slot, ready for live_set_notes. One
 * queued transaction = one undo. Targets Session slots only; the slot must be
 * on a MIDI track and empty. Arrangement-clip creation is not supported.
 */

import { z } from 'zod';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { ClipSlotReference } from '../../schemas/primitives.js';

const inputSchema = z
  .object({
    slotId: ClipSlotReference,
    lengthBeats: z.number().finite().min(0.25).describe('Clip length in beats, minimum 0.25'),
  })
  .strict();

export const createMidiClipTool = defineTool({
  name: 'live_create_midi_clip',
  title: 'Create MIDI clip',
  description:
    'Create an empty MIDI clip in a Session clip slot (given a length in beats, minimum 0.25), ' +
    'ready for live_set_notes. One undo step. The slot reference must be an empty slot on a MIDI track ' +
    '(from live_list_clips). Returns the new clip and slot references.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    // Not idempotent: a second call targets an occupied slot and is rejected.
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    const clip = await bridge.createMidiClip(args.slotId, args.lengthBeats);
    const data = {
      clipId: clip.id,
      slotId: clip.slotId ?? args.slotId,
      lengthBeats: clip.duration,
    };
    return ok(
      data,
      `Created a MIDI clip (${String(clip.duration)} beats). Add notes with ` +
        'live_set_notes using the returned clip reference.',
    );
  },
});
