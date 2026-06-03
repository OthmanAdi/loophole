/**
 * The three read-only Resources (02_BRIDGE_SPEC §6.1).
 *
 * Resources give the model cheap, browsable read context without spending a tool
 * call and without enlarging the tool list. All are read-only, all return JSON
 * (names + path ids, never a handle), all capped at the character limit. They are
 * backed by the same `LiveBridge` read methods the read tools use, so they add no
 * new SDK surface.
 *
 * | URI                              | Backed by                                   |
 * |----------------------------------|---------------------------------------------|
 * | `ableton://song`                 | `getSongOverview()`                         |
 * | `ableton://track/{i}`            | `listClips("track:{i}")` + `listDeviceParams` |
 * | `ableton://clip/{path}/notes`    | `getNotes(path)`                            |
 *
 * URI note (the `{path}` trap): a clip id like `track:2/clipslot:4/clip` contains
 * `/` and `:`, which a plain `{path}` template variable cannot carry. Clients
 * therefore percent-encode the clip id into the single `{path}` segment, and the
 * handler `decodeURIComponent`s it back before resolving.
 */

import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { makePathId, trackId, type LiveBridge } from '@othmanadi/loophole-core';

import { truncate } from '../result/truncate.js';

/** Build a single-text-content resource result with the JSON body, capped. */
function jsonResource(uri: URL, data: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: truncate(JSON.stringify(data, null, 2)),
      },
    ],
  };
}

/**
 * Register the three read-only resources on `server`, each backed by `bridge`.
 *
 * A `BridgeError` thrown by a read (a stale id, a wrong type) propagates as a
 * normal resource-read failure; unlike tools, resources have no `safeHandle`
 * wrapper because there is no recovery-hint contract for resource reads. The
 * model falls back to the equivalent read tool, which does carry the hint.
 */
export function registerResources(server: McpServer, bridge: LiveBridge): void {
  // ableton://song — the overview snapshot.
  server.registerResource(
    'song',
    'ableton://song',
    {
      title: 'Song overview',
      description:
        'The Live Set overview: tempo, scale, grid, object counts, and the track list with ids.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => jsonResource(uri, bridge.getSongOverview()),
  );

  // ableton://track/{i} — one track's clips and devices/params.
  server.registerResource(
    'track',
    new ResourceTemplate('ableton://track/{i}', { list: undefined }),
    {
      title: 'Track detail',
      description:
        "One track's clips (session + arrangement) and its device parameters with ids. {i} is " +
        'the track order index, e.g. ableton://track/2.',
      mimeType: 'application/json',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const raw = Array.isArray(variables.i) ? variables.i[0] : variables.i;
      const index = Number(raw);
      const id = trackId(index);
      // listDeviceParams is async (a parameter's live value comes from the one async
      // SDK getter); listClips stays sync. await the params before shaping the JSON.
      const data = {
        trackId: id,
        clips: bridge.listClips(id),
        params: await bridge.listDeviceParams(id),
      };
      return jsonResource(uri, data);
    },
  );

  // ableton://clip/{path}/notes — one clip's notes. {path} is the percent-encoded clip id.
  server.registerResource(
    'clip-notes',
    new ResourceTemplate('ableton://clip/{path}/notes', { list: undefined }),
    {
      title: 'Clip notes',
      description:
        "One MIDI clip's notes as plain note objects. {path} is the percent-encoded clip id " +
        '(e.g. encodeURIComponent("track:2/clipslot:4/clip")).',
      mimeType: 'application/json',
    },
    (uri, variables): ReadResourceResult => {
      const raw = Array.isArray(variables.path) ? variables.path[0] : variables.path;
      const clipId = makePathId(decodeURIComponent(raw ?? ''));
      const notes = bridge.getNotes(clipId);
      return jsonResource(uri, { clipId, count: notes.length, notes });
    },
  );
}
