/**
 * Tool 1 — `live_get_song_overview` (read).
 *
 * One cheap orientation snapshot of the Set: tempo, scale, grid, object counts,
 * and the track list with ids. The first call in almost every session; the model
 * drills down with the other read tools rather than dumping the whole Set
 * (02_BRIDGE_SPEC §5, tool 1).
 */

import { z } from 'zod';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';

const inputSchema = z.object({}).strict();

export const getSongOverviewTool = defineTool({
  name: 'live_get_song_overview',
  title: 'Get song overview',
  description:
    'Return one cheap snapshot of the Live Set: tempo, scale, grid, track / scene / cue ' +
    'counts, and the list of tracks (each with a stable id, name, and type). Call this first ' +
    'to orient, then drill down with live_list_clips / live_get_notes. No notes or clip ' +
    'contents are included.',
  inputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: (_args, bridge) => {
    const overview = bridge.getSongOverview();
    const summary =
      `Set: ${String(overview.tempo)} BPM, ` +
      `${overview.scaleName} scale, ` +
      `${String(overview.trackCount)} tracks, ${String(overview.sceneCount)} scenes. ` +
      `Tracks: ${overview.tracks.map((t) => `${t.name} (${t.id})`).join(', ')}.`;
    return Promise.resolve(ok(overview, summary));
  },
});
