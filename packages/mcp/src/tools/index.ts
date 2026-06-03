/**
 * The tool collection: an EXPLICIT list of all 12 tool modules.
 *
 * Explicit imports (no glob, no directory scan) so the bundler can see every
 * tool statically and tree-shaking / esbuild never drops one (02_BRIDGE_SPEC §9).
 * Adding a tool means importing it here and adding it to {@link collectTools}.
 *
 * `registerTool` is re-exported so `server.ts` has a single import site for the
 * registration machinery.
 */

import type { ToolModule } from './registry.js';

import { getSongOverviewTool } from './song/get-overview.tool.js';
import { findTrackTool } from './song/find-track.tool.js';
import { setTempoTool } from './song/set-tempo.tool.js';
import { createTrackTool } from './song/create-track.tool.js';
import { listClipsTool } from './clips/list-clips.tool.js';
import { getNotesTool } from './clips/get-notes.tool.js';
import { setNotesTool } from './clips/set-notes.tool.js';
import { createMidiClipTool } from './clips/create-midi-clip.tool.js';
import { setTrackPropsTool } from './tracks/set-track-props.tool.js';
import { setParamTool } from './devices/set-param.tool.js';
import { insertDeviceTool } from './devices/insert-device.tool.js';
import { renderTrackTool } from './render/render-track.tool.js';

export { registerTool } from './registry.js';

/**
 * All 12 Loophole Bridge tools, in a stable order (reads first, then writes,
 * grouped by domain). `buildServer` registers each one.
 */
export function collectTools(): readonly ToolModule[] {
  return [
    // reads
    getSongOverviewTool,
    findTrackTool,
    listClipsTool,
    getNotesTool,
    // writes
    setTempoTool,
    setTrackPropsTool,
    setNotesTool,
    createTrackTool,
    createMidiClipTool,
    setParamTool,
    insertDeviceTool,
    renderTrackTool,
  ];
}
