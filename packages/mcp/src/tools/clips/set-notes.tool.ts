/**
 * Tool 7 — `live_set_notes` (write).
 *
 * Replace all MIDI notes in a clip (the read-map-assign-back contract); the
 * workhorse behind humanize, quantize, and write-a-melody. One queued
 * transaction = one undo. The bridge clamps pitch/velocity to 0..127 as a
 * backstop, the way Live rejects out-of-range writes.
 */

import { z } from 'zod';

import type { NoteDTO } from '@othmanadi/loophole-core';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { ClipReference, NoteSchema } from '../../schemas/primitives.js';

const inputSchema = z
  .object({
    clipId: ClipReference,
    notes: z.array(NoteSchema).describe('Full replacement set of notes for the clip'),
  })
  .strict();

export const setNotesTool = defineTool({
  name: 'live_set_notes',
  title: 'Set notes',
  description:
    'Replace ALL MIDI notes in one clip reference with the given array (whole-array assign-back: read with ' +
    'live_get_notes, transform, write back). One undo step. Pitch and velocity are clamped to ' +
    '0-127. The clip reference must be a MIDI clip. Returns the clip reference, name, and resulting note count.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    // Idempotent: writing the same array again lands the same clip state.
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    // Cast at the forward boundary: Zod infers optional note fields as
    // `T | undefined`, but core's NoteDTO omits absent keys (exactOptionalPropertyTypes).
    // The runtime values are sound (JSON never carries `undefined`, and core's
    // noteFromDTO gates every optional), so this only strips a pessimistic type.
    const result = await bridge.setNotes(args.clipId, args.notes as readonly NoteDTO[]);
    return ok(result, `Wrote ${String(result.count)} notes to the referenced clip.`);
  },
});
