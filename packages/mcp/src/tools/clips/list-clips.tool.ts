/**
 * Tool 3 — `live_list_clips` (read).
 *
 * See what clips exist on one track, with the ids needed to read or write them.
 * Reports Session-view slots (including empty ones, so the model knows where it
 * can create a clip) and Arrangement clips, each tagged with its location and
 * kind (02_BRIDGE_SPEC §5, tool 3).
 */

import { z } from 'zod';

import { makePathId, type ClipInfo } from '@othmanadi/loophole-core';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { TrackId } from '../../schemas/primitives.js';

const inputSchema = z.object({ trackId: TrackId }).strict();

/** Shape the bridge's flat ClipInfo[] into session vs arrangement groups. */
function shapeClips(clips: readonly ClipInfo[]): {
  session: readonly Record<string, unknown>[];
  arrangement: readonly Record<string, unknown>[];
} {
  const session: Record<string, unknown>[] = [];
  const arrangement: Record<string, unknown>[] = [];
  for (const clip of clips) {
    if (clip.location === 'session') {
      session.push({
        slotId: clip.slotId ?? clip.id,
        clipId: clip.kind === 'empty' ? null : clip.id,
        name: clip.kind === 'empty' ? null : clip.name,
        kind: clip.kind,
      });
    } else {
      arrangement.push({
        clipId: clip.id,
        name: clip.name,
        startBeat: clip.startTime,
        endBeat: clip.endTime,
        kind: clip.kind,
      });
    }
  }
  return { session, arrangement };
}

export const listClipsTool = defineTool({
  name: 'live_list_clips',
  title: 'List clips',
  description:
    'List the clips on one track: Session-view slots (empty slots included, so you can see ' +
    'where to create a clip) and Arrangement clips, each with its stable id, name, and kind ' +
    '(midi / audio / empty). Pass a clip id to live_get_notes / live_set_notes, or a slot id ' +
    'to live_create_midi_clip.',
  inputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: (args, bridge) => {
    const trackId = makePathId(args.trackId);
    const clips = bridge.listClips(trackId);
    const { session, arrangement } = shapeClips(clips);
    const data = { trackId, session, arrangement };
    const summary =
      `Track ${args.trackId}: ${String(session.length)} session slot(s), ` +
      `${String(arrangement.length)} arrangement clip(s).`;
    return Promise.resolve(ok(data, summary));
  },
});
