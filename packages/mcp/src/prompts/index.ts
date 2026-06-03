/**
 * The recipe Prompts (02_BRIDGE_SPEC §6.2).
 *
 * A small set of MCP Prompts ships the cookbook operations as reusable,
 * parameterized scaffolds. They are TEMPLATES that compose the 12 tools, not new
 * capability, and there is NO Sampling: the server never asks the client to run a
 * model on its behalf.
 *
 * `registerPrompt`'s `argsSchema` is a raw Zod shape (a `Record` of field
 * schemas), and prompt arguments are string-valued by the MCP spec, so the
 * schemas here are `z.string()` (with `.describe`), not the full strict objects
 * the tools use. Each callback returns a `GetPromptResult` whose single `user`
 * message is the filled-in instruction.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** Wrap instruction text into the single-user-message GetPromptResult shape. */
function userMessage(text: string): GetPromptResult {
  return {
    messages: [
      {
        role: 'user',
        content: { type: 'text', text },
      },
    ],
  };
}

/**
 * Register the recipe prompts on `server`. Templates only; no Sampling.
 */
export function registerPrompts(server: McpServer): void {
  // humanize_clip — read notes, nudge off the grid, write them back.
  server.registerPrompt(
    'humanize_clip',
    {
      title: 'Humanize a clip',
      description:
        'Scaffold for humanizing a MIDI clip: read its notes, nudge timing / velocity / ' +
        'probability slightly off the grid, and write them back.',
      argsSchema: {
        clipId: z.string().describe("The clip id to humanize, e.g. 'track:2/clipslot:4/clip'"),
        amount: z
          .string()
          .describe('How much to humanize, as a small beats value, e.g. "0.05" (subtle) to "0.2".'),
      },
    },
    ({ clipId, amount }): GetPromptResult =>
      userMessage(
        `Humanize the MIDI clip ${clipId} by about ${amount} beats.\n\n` +
          `1. Call live_get_notes with clipId "${clipId}" to read the current notes.\n` +
          `2. For each note, nudge startTime by a small random amount within +/- ${amount} ` +
          `beats (never below 0), and optionally vary velocity by a few units and probability ` +
          `slightly, so the part feels played rather than quantized.\n` +
          `3. Call live_set_notes with the same clipId and the full transformed note array ` +
          `(it replaces all notes in one undo step).\n` +
          `Keep the note count and pitches unchanged; only timing / velocity / probability move.`,
      ),
  );

  // build_arrangement — scaffold the Session-to-Song flow against the read tools.
  server.registerPrompt(
    'build_arrangement',
    {
      title: 'Build an arrangement',
      description:
        'Scaffold for sketching an arrangement from the current Session: survey the Set, then ' +
        'plan a section order. Forward-looking; the flagship extension implements the heavy ' +
        'version.',
      argsSchema: {
        style: z
          .string()
          .optional()
          .describe('Optional style or vibe to aim for, e.g. "build to a big drop".'),
      },
    },
    ({ style }): GetPromptResult =>
      userMessage(
        `Sketch an arrangement plan from the current Live Set${
          style ? ` aiming for: ${style}` : ''
        }.\n\n` +
          `1. Call live_get_song_overview to see tempo, tracks, and scene count.\n` +
          `2. For the key tracks, call live_list_clips to see which Session clips exist.\n` +
          `3. Propose a section order (intro / verse / chorus / break / outro) referencing the ` +
          `clips by id, and describe how to lay them on the Arrangement timeline.\n` +
          `Do not mutate anything yet: this is a plan for the user to approve first.`,
      ),
  );

  // batch_rename — rename tracks via find + set-track-props.
  server.registerPrompt(
    'batch_rename',
    {
      title: 'Batch rename tracks',
      description:
        'Scaffold for renaming several tracks consistently: find each by name, then apply a new ' +
        'name via live_set_track_props.',
      argsSchema: {
        pattern: z
          .string()
          .describe(
            'The renaming rule, e.g. "prefix drum tracks with DRUM_" or "Title Case every name".',
          ),
      },
    },
    ({ pattern }): GetPromptResult =>
      userMessage(
        `Rename tracks following this rule: ${pattern}.\n\n` +
          `1. Call live_get_song_overview (or live_find_track for a subset) to get the current ` +
          `track names and ids.\n` +
          `2. Compute each new name from the rule.\n` +
          `3. For each track that changes, call live_set_track_props with its id and ` +
          `{ name: "<new name>" } (one undo step per track).\n` +
          `Report the old -> new mapping before applying if the change is large.`,
      ),
  );
}
