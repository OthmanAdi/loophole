/**
 * Gain Stage Doctor (W3) context-menu command, 03_EXTENSIONS_SPEC §3.
 *
 * Registers `"Gain Stage…"` on `"AudioTrack"` and `"AudioTrack.ArrangementSelection"`,
 * shows the modal (target dropdown + per-track checklist), then runs the pure-core
 * {@link runGainStageDoctor} INSIDE a progress dialog, injecting the real WAV decode
 * (`fs.readFile` + the `audio-decode` package). The handler renders each chosen track's
 * pre-FX audio, measures peak/RMS/crest, and writes every trim in one undo.
 *
 * Handler shape vs spec UI (decided, flagged RING-3): `runGainStageDoctor` measures AND
 * writes in a single call with the target chosen up front, so this command picks the
 * target + the track subset BEFORE rendering (the "measure → show table → apply a
 * subset" interaction from §3(c) cannot be expressed against a one-shot handler without
 * re-implementing its body). The measured rows the handler returns are surfaced in a
 * short read-only report modal AFTER the run, so the user still sees the table. Calling
 * the shared handler (rather than re-deriving the math) is the explicit task choice.
 *
 * `audio-decode` is NOT the Ableton SDK; it is a normal npm dependency the extension
 * declares (mirroring the official `strip-silence` example). `fs/promises` is Node.
 *
 * SDK-facing; CI-excluded; typechecked locally via `tsconfig.live.json`.
 *
 * RING-3 PENDING: the pre-FX render, the decode of a real WAV, and the dB→internal
 * volume mapping (`dbToParamValue`) are all confirmed only in real Live. The handler +
 * loudness math are the ring-1/ring-2 code, exercised against `FakeLiveBridge` with a
 * fake decode.
 */

import { readFile } from 'node:fs/promises';
import decodeAudio from 'audio-decode';
import type { ArrangementSelection, ExtensionContext, Handle } from '@ableton-extensions/sdk';
import {
  type DecodeWav,
  type GainStageRow,
  type LiveBridge,
  runGainStageDoctor,
  type TrackId,
} from '@othmanadi/loophole-core';
import { audioTrackSelectionToTargets, trackIdFromHandle } from '../adapter/selection.js';
import { AudioTrack } from '../adapter/selection.js';
import type { V } from '../adapter/resolver.js';
import { TEMPLATES, dialogUrl } from '../webviews/index.js';
import { parseModalResult, runCommand } from './support.js';

const COMMAND_ID = 'loophole.gsd.run';
const LABEL = 'Gain Stage…';
const DIALOG_WIDTH = 560;
const DIALOG_HEIGHT = 420;

/** The RMS targets the modal offers (dBFS); default −18 (03_EXTENSIONS_SPEC §3(c)). */
const TARGET_OPTIONS = [-18, -20, -12] as const;

/**
 * The minimal structural shape of the `audio-decode` result we use (a Web Audio
 * `AudioBuffer`). Declared locally so the extension does not need the DOM lib just to
 * read `numberOfChannels` / `getChannelData` / `sampleRate`.
 */
interface DecodedAudio {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/** What the Gain Stage modal posts back. `targetDb` is `null` on cancel. */
interface GainStageModalResult {
  readonly targetDb: number | null;
  readonly applyTrackIds: readonly string[];
}

/** A `{ id, name }` row the modal renders as the track checklist. */
interface TrackRow {
  readonly id: string;
  readonly name: string;
}

/**
 * Register the Gain Stage Doctor command + its two context-menu actions.
 *
 * @param api the live SDK context (also used to render pre-FX audio and read names).
 * @param bridge the real {@link LiveBridge} adapter.
 */
export function register(api: ExtensionContext<V>, bridge: LiveBridge): void {
  api.commands.registerCommand(COMMAND_ID, (...args: unknown[]) => {
    void runCommand(LABEL, () => handle(api, bridge, args[0]));
  });
  void api.ui.registerContextMenuAction('AudioTrack', LABEL, COMMAND_ID);
  void api.ui.registerContextMenuAction('AudioTrack.ArrangementSelection', LABEL, COMMAND_ID);
}

/**
 * Resolve the selected audio tracks, show the target + subset modal, then run
 * {@link runGainStageDoctor} over the chosen subset inside a progress dialog, and show
 * the measured rows afterwards.
 */
async function handle(api: ExtensionContext<V>, bridge: LiveBridge, arg: unknown): Promise<void> {
  const trackIds = resolveTrackIds(api, arg);
  if (trackIds.length === 0) {
    console.error('[loophole] Gain Stage: no audio track in the selection.');
    return;
  }

  const rows: TrackRow[] = trackIds.map((id) => ({ id, name: trackName(bridge, id) }));
  const url = dialogUrl(TEMPLATES.gainStage, { tracks: rows, targets: TARGET_OPTIONS });
  const result = parseModalResult<GainStageModalResult>(
    await api.ui.showModalDialog(url, DIALOG_WIDTH, DIALOG_HEIGHT),
  );
  if (result === null || result.targetDb === null) {
    return; // cancelled
  }

  const chosen = trackIds.filter((id) => result.applyTrackIds.includes(id));
  if (chosen.length === 0) {
    return; // nothing ticked
  }

  const decode = makeDecode();
  // Render + measure + trim inside a progress dialog; the render loop lives in the
  // handler, so a single coarse progress tick wraps the whole run. The handler honors
  // no abort signal itself, so we surface cancellation as a no-op after it resolves.
  const measured = await api.ui.withinProgressDialog(
    'Gain staging tracks…',
    { progress: 0 },
    async (update, signal): Promise<readonly GainStageRow[]> => {
      await update('Rendering and measuring…', 20);
      if (signal.aborted) {
        return [];
      }
      const { rows: measuredRows } = await runGainStageDoctor(
        bridge,
        { trackIds: chosen, targetDb: result.targetDb as number },
        decode,
      );
      await update('Applying trims…', 90);
      return measuredRows;
    },
  );

  await showReport(api, (measured as readonly GainStageRow[]) ?? [], result.targetDb);
}

/** Turn the scope's argument into the list of audio track ids to stage. */
function resolveTrackIds(api: ExtensionContext<V>, arg: unknown): TrackId[] {
  if (isArrangementSelection(arg)) {
    return audioTrackSelectionToTargets(api, arg).trackIds;
  }
  // Single "AudioTrack" scope: a track Handle. Keep it only if it is an audio track.
  const handle = arg as Handle;
  const id = trackIdFromHandle(api, handle);
  if (id === null) {
    return [];
  }
  const obj = api.getObjectFromHandle(handle, AudioTrack);
  return obj instanceof AudioTrack ? [id] : [];
}

function isArrangementSelection(arg: unknown): arg is ArrangementSelection {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    'selected_lanes' in arg &&
    'time_selection_start' in arg
  );
}

/** The display name of a track id, via a bridge read (falls back to the id). */
function trackName(bridge: LiveBridge, id: TrackId): string {
  for (const track of bridge.listTracks()) {
    if (track.id === id) {
      return track.name;
    }
  }
  return id;
}

/**
 * Build the real {@link DecodeWav}: read the rendered WAV off disk and decode it to
 * `Float32Array` channels with `audio-decode`, exactly the `strip-silence` example
 * pattern (`decodeAudio(await fs.readFile(path))` then `getChannelData(i)`).
 */
function makeDecode(): DecodeWav {
  return async (wavPath: string): Promise<Float32Array[]> => {
    const buffer = await readFile(wavPath);
    const decoded = (await decodeAudio(buffer)) as DecodedAudio;
    return Array.from({ length: decoded.numberOfChannels }, (_, channel) =>
      decoded.getChannelData(channel),
    );
  };
}

/**
 * Show a short read-only report of the measured rows after the run (the §3(c) table:
 * track, peak dBFS, RMS dBFS, crest, suggested trim). Built as a simple HTML data URL;
 * the dialog closes itself on any key.
 */
async function showReport(
  api: ExtensionContext<V>,
  rows: readonly GainStageRow[],
  targetDb: number,
): Promise<void> {
  const body =
    rows.length === 0
      ? '<tr><td colspan="5" class="empty">No tracks measured.</td></tr>'
      : rows
          .map(
            (r) =>
              `<tr><td>${escapeHtml(r.track)}</td><td>${fmt(r.peakDb)}</td><td>${fmt(
                r.rmsDb,
              )}</td><td>${fmt(r.crest)}</td><td>${fmt(r.trimDb)}</td></tr>`,
          )
          .join('');
  // Replacement FUNCTIONS, not strings: a `$&`/`$$`/`$'` in a track name (which lands
  // in `body` via the row HTML; escapeHtml does not touch `$`) would otherwise be
  // interpreted as a String.replace special pattern and corrupt the report.
  const html = REPORT_HTML.replace('__TARGET__', () => String(targetDb)).replace(
    '__ROWS__',
    () => body,
  );
  await api.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, DIALOG_WIDTH, 360);
}

/** Format a dB value to one decimal place for the report table. */
function fmt(db: number): string {
  return Number.isFinite(db) ? db.toFixed(1) : '—';
}

/** Escape a track name for safe interpolation into the report HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The read-only post-run report template (the measured table). Kept inline here (not a
 * `.html` asset) because it is informational, has no controls beyond close, and is
 * populated entirely by the host. Uses the Live dark theme tokens like the modals.
 */
const REPORT_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Gain Stage Report</title>
<script>
  const isWebKit = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live;
  const isWebView2 = window.chrome && window.chrome.webview;
  function close() {
    const m = { method: 'close_and_send', params: [JSON.stringify({ ok: true })] };
    if (isWebKit) window.webkit.messageHandlers.live.postMessage(m);
    else if (isWebView2) window.chrome.webview.postMessage(m);
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('keydown', () => close());
    document.getElementById('done').addEventListener('click', close);
  });
</script>
<style>
  *,*::before,*::after{box-sizing:border-box}*:not(dialog){margin:0}button{font:inherit}
  :root{--bg:hsl(0,0%,21%);--fg:hsl(0,0%,71%);--sec:hsl(0,0%,41%);--bd:hsl(0,0%,7%);--ctl:hsl(0,0%,16%);--acc:hsl(31,100%,67%)}
  html{background:var(--bg);color:var(--fg);font-family:'AbletonSansSmall',sans-serif;font-size:11.5px;font-weight:500;height:100%}
  body{height:100%;padding:1.25em;display:flex;flex-direction:column;gap:.6em}
  .title{font-size:1.1rem}.sub{color:var(--sec)}
  .wrap{flex:1;overflow:auto;border:1px solid var(--bd)}
  table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.3em .5em;border-bottom:1px solid var(--bd)}
  th{color:var(--sec);position:sticky;top:0;background:var(--ctl)}td.empty{color:var(--sec);text-align:center;padding:1em}
  .buttons{display:flex;justify-content:flex-end}
  button{background:var(--ctl);color:var(--fg);border:1px solid var(--bd);height:22px;padding:0 1em;border-radius:1em;cursor:pointer}
  button:active{background:var(--acc);color:var(--bd)}
</style></head><body>
<div class="title">Gain Stage Report</div>
<div class="sub">Target __TARGET__ dBFS RMS. Trims applied. One undo reverts all.</div>
<div class="wrap"><table><thead><tr><th>Track</th><th>Peak</th><th>RMS</th><th>Crest</th><th>Trim</th></tr></thead>
<tbody>__ROWS__</tbody></table></div>
<div class="buttons"><button id="done">Done</button></div>
</body></html>`;
