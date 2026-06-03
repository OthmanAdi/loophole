/**
 * Tool 12 — `live_render_track` (write).
 *
 * Bounce a track's pre-FX audio over a beat range to a WAV file in the temp
 * directory, and return the path (the seam Gain Stage Doctor sits on). This
 * produces a file, it does not change the Set, so it is NOT a transaction (there
 * is nothing to undo). The render is pre-FX and, per the SDK, practical for audio
 * tracks; the description says so plainly (02_BRIDGE_SPEC §5 tool 12).
 *
 * The cross-field `endBeat > startBeat` constraint is expressed with `.refine`,
 * which is why this tool's input is a full object schema with a refinement.
 */

import { z } from 'zod';

import { makePathId } from '@othmanadi/loophole-core';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { Beats, TrackId } from '../../schemas/primitives.js';

const inputSchema = z
  .object({
    trackId: TrackId,
    startBeat: Beats,
    endBeat: Beats,
  })
  .strict()
  .refine((a) => a.endBeat > a.startBeat, 'endBeat must be greater than startBeat');

export const renderTrackTool = defineTool({
  name: 'live_render_track',
  title: 'Render track',
  description:
    "Render a track's pre-FX audio over a beat range (startBeat..endBeat) to a WAV file in the " +
    "temp directory, and return the path. The render is PRE-FX (before the track's device chain) " +
    'and practical for audio tracks; it is not a post-FX master bounce. This writes a file and ' +
    'does not change the Set, so there is nothing to undo.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    // Idempotent in effect: rendering the same range overwrites the same file
    // and never mutates the Set.
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    const trackId = makePathId(args.trackId);
    const result = await bridge.renderTrack(trackId, args.startBeat, args.endBeat);
    const data = {
      trackId,
      track: result.track,
      path: result.path,
      note: 'pre-FX, audio written to the temp dir',
    };
    return ok(data, `Rendered ${result.track} (pre-FX) to ${result.path}.`);
  },
});
