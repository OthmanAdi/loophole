/**
 * Tool 2 — `live_find_track` (read).
 *
 * Turn a human track reference ("the bass", "Drums") into stable track ids, and
 * disambiguate when several match. Zero matches is a valid answer (not an error):
 * the result reports `count: 0` with a hint to list all tracks
 * (02_BRIDGE_SPEC §5, tool 2).
 */

import { z } from 'zod';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';

const inputSchema = z
  .object({
    query: z.string().min(1).describe('Track name or substring, case-insensitive'),
  })
  .strict();

export const findTrackTool = defineTool({
  name: 'live_find_track',
  title: 'Find track',
  description:
    'Resolve a human track name or substring (case-insensitive) to the stable track ids that ' +
    'match, each with its name and type. Returns count 0 with a hint when nothing matches; that ' +
    'is a valid answer, not an error. Use the returned id with live_list_clips / ' +
    'live_set_track_props.',
  inputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: (args, bridge) => {
    const matches = bridge.findTrack(args.query);
    const data = { matches, count: matches.length };
    const summary =
      matches.length === 0
        ? `No track matches "${args.query}". Call live_get_song_overview to see all track names.`
        : `${String(matches.length)} match(es): ${matches
            .map((m) => `${m.name} (${m.id})`)
            .join(', ')}.`;
    return Promise.resolve(ok(data, summary));
  },
});
