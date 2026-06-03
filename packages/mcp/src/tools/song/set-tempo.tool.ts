/**
 * Tool 5 — `live_set_tempo` (write).
 *
 * Set the Set tempo in BPM. One queued transaction = one undo. The valid range
 * (20..999) is enforced by Zod before the handler runs, so an out-of-range value
 * is a clean `BAD_INPUT` (02_BRIDGE_SPEC §5, tool 5).
 */

import { z } from 'zod';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';

const inputSchema = z
  .object({
    bpm: z.number().min(20).max(999).describe('Beats per minute, 20-999'),
  })
  .strict();

export const setTempoTool = defineTool({
  name: 'live_set_tempo',
  title: 'Set tempo',
  description:
    'Set the Live Set tempo in beats per minute (20-999). One undo step. Returns the updated ' +
    'song overview.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    const overview = await bridge.setTempo(args.bpm);
    return ok(overview, `Tempo set to ${String(overview.tempo)} BPM.`);
  },
});
