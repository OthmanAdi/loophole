/**
 * Tool 4 — `live_get_notes` (read).
 *
 * Read the MIDI content of one clip so the model can reason about or transform
 * it. For a clip whose note dump would blow the character cap, the tool returns a
 * summary (count, pitch range, beat span, first N notes) plus a narrowing hint,
 * rather than a silent partial dump (02_BRIDGE_SPEC §5 tool 4, §8).
 */

import { z } from 'zod';

import { makePathId, type NoteDTO } from '@othmanadi/loophole-core';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { ClipId } from '../../schemas/primitives.js';

const inputSchema = z.object({ clipId: ClipId }).strict();

/** Above this many notes, summarize instead of dumping the full array. */
const NOTE_DUMP_LIMIT = 400;
/** How many notes to include in a summarized response. */
const SUMMARY_NOTE_COUNT = 50;

/** Compute a compact summary (pitch range + beat span) of a note set. */
function summarize(notes: readonly NoteDTO[]): {
  pitchMin: number;
  pitchMax: number;
  spanBeats: number;
} {
  let pitchMin = Number.POSITIVE_INFINITY;
  let pitchMax = Number.NEGATIVE_INFINITY;
  let spanBeats = 0;
  for (const note of notes) {
    if (note.pitch < pitchMin) pitchMin = note.pitch;
    if (note.pitch > pitchMax) pitchMax = note.pitch;
    const end = note.startTime + note.duration;
    if (end > spanBeats) spanBeats = end;
  }
  return { pitchMin, pitchMax, spanBeats };
}

export const getNotesTool = defineTool({
  name: 'live_get_notes',
  title: 'Get notes',
  description:
    'Read all MIDI notes from one clip as plain note objects (pitch, startTime, duration, and ' +
    'optional velocity / muted / probability). For a very large clip, returns a summary (count, ' +
    'pitch range, beat span, first notes) plus a hint instead of a full dump. The clip id must ' +
    'be a MIDI clip from live_list_clips.',
  inputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: (args, bridge) => {
    const clipId = makePathId(args.clipId);
    const notes = bridge.getNotes(clipId);
    if (notes.length <= NOTE_DUMP_LIMIT) {
      const data = { clipId, count: notes.length, notes };
      return Promise.resolve(ok(data, `${String(notes.length)} note(s) in ${clipId}.`));
    }
    // Too many notes to dump: return a summary + the first N notes + a hint.
    const stats = summarize(notes);
    const data = {
      clipId,
      count: notes.length,
      summary: {
        pitchRange: [stats.pitchMin, stats.pitchMax],
        spanBeats: stats.spanBeats,
      },
      firstNotes: notes.slice(0, SUMMARY_NOTE_COUNT),
      truncated: true,
    };
    const summaryText =
      `${String(notes.length)} notes in ${clipId} (too many to return in full). ` +
      `Pitch ${String(stats.pitchMin)}-${String(stats.pitchMax)}, span ${String(stats.spanBeats)} ` +
      `beats. Showing the first ${String(SUMMARY_NOTE_COUNT)}.`;
    return Promise.resolve(ok(data, summaryText));
  },
});
