/**
 * Scale Lock (W1) context-menu command, 03_EXTENSIONS_SPEC §1(c).
 *
 * Registers `"Lock to Scale…"` on the `"MidiClip"` and `"ClipSlotSelection"` scopes,
 * shows the Scale Lock modal pre-filled with the Set's live scale and a dry off-scale
 * count, parses the chosen snap `mode`, and calls the pure-core {@link runScaleLock}
 * with the bridge. One run is one undo (the handler wraps every clip write in one
 * `LiveBridge.transaction`).
 *
 * The dry count is computed without mutating anything: read the scale + each target
 * clip's notes through the bridge, run the exported pure {@link snapToScale}, and sum
 * `movedCount`. This is the "after a dry pass a count line" the spec asks for, done with
 * the same transform the handler uses, so the preview cannot drift from the result.
 *
 * SDK-facing (imports the adapter selection helpers + the SDK context type), so it is
 * CI-excluded and typechecked locally via `tsconfig.live.json`.
 *
 * RING-3 PENDING: the scope's argument shape, the modal round-trip, and the one-undo
 * grouping are confirmed only in real Live; the resolve + transform logic is the same
 * code ring 2 exercises against `FakeLiveBridge`.
 */

import type { ClipSlotSelection, ExtensionContext, Handle } from '@ableton-extensions/sdk';
import {
  type ClipId,
  type LiveBridge,
  type Scale,
  snapToScale,
  runScaleLock,
  type SnapMode,
} from '@othmanadi/loophole-core';
import { clipIdFromHandle, midiClipIdsFromSlotSelection } from '../adapter/selection.js';
import type { V } from '../adapter/resolver.js';
import { TEMPLATES, dialogUrl } from '../webviews/index.js';
import { parseModalResult, runCommand } from './support.js';

/** The command id Live invokes; also the context-menu action's target. */
const COMMAND_ID = 'loophole.scalelock.run';

/** The context-menu label (03_EXTENSIONS_SPEC §1(c)). */
const LABEL = 'Lock to Scale…';

/** The modal dialog size (close to the example's 320×220). */
const DIALOG_WIDTH = 340;
const DIALOG_HEIGHT = 240;

/** Pitch-class names for the live scale label (root note 0..11). */
const PITCH_CLASS_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

/** What the Scale Lock modal posts back via `close_and_send`. */
interface ScaleLockModalResult {
  /** The chosen snap mode, or `null` when the dialog was cancelled. */
  readonly mode: SnapMode | null;
}

/** The data the host templates into the modal: the live scale label + dry counts. */
interface ScaleLockModalData {
  readonly scaleLabel: string;
  readonly offScaleCount: number;
  readonly noteCount: number;
}

/**
 * Register the Scale Lock command + its two context-menu actions. Called once from
 * `activate()` with the live SDK context and the real {@link LiveBridge} adapter.
 */
export function register(api: ExtensionContext<V>, bridge: LiveBridge): void {
  api.commands.registerCommand(COMMAND_ID, (...args: unknown[]) => {
    void runCommand(LABEL, () => handle(api, bridge, args[0]));
  });
  void api.ui.registerContextMenuAction('MidiClip', LABEL, COMMAND_ID);
  void api.ui.registerContextMenuAction('ClipSlotSelection', LABEL, COMMAND_ID);
}

/**
 * Resolve the right-clicked target to clip ids, show the modal with a dry off-scale
 * count, and run {@link runScaleLock} on Apply. A single `"MidiClip"` scope passes a
 * `Handle`; the `"ClipSlotSelection"` scope passes a {@link ClipSlotSelection}.
 */
async function handle(api: ExtensionContext<V>, bridge: LiveBridge, arg: unknown): Promise<void> {
  const clipIds = resolveClipIds(api, arg);
  if (clipIds.length === 0) {
    console.error('[loophole] Lock to Scale: no MIDI clip in the selection.');
    return;
  }

  const data = computeModalData(bridge, clipIds);
  const url = dialogUrl(TEMPLATES.scaleLock, data);
  const result = parseModalResult<ScaleLockModalResult>(
    await api.ui.showModalDialog(url, DIALOG_WIDTH, DIALOG_HEIGHT),
  );
  if (result === null || result.mode === null) {
    return; // cancelled
  }

  await runScaleLock(bridge, { clipIds, mode: result.mode });
}

/** Turn the scope's argument into the list of MIDI clip ids to lock. */
function resolveClipIds(api: ExtensionContext<V>, arg: unknown): ClipId[] {
  if (isClipSlotSelection(arg)) {
    return midiClipIdsFromSlotSelection(api, arg);
  }
  // Otherwise a single clip Handle from the "MidiClip" scope.
  const id = clipIdFromHandle(api, arg as Handle);
  return id === null ? [] : [id];
}

/** Structural check for a {@link ClipSlotSelection} (vs a single clip {@link Handle}). */
function isClipSlotSelection(arg: unknown): arg is ClipSlotSelection {
  return typeof arg === 'object' && arg !== null && 'selected_clip_slots' in arg;
}

/**
 * Build the modal data: the live scale label, the total note count across the target
 * clips, and the dry off-scale count from the pure {@link snapToScale} (nearest mode,
 * matching the modal default). No mutation; reads through the bridge only.
 */
function computeModalData(bridge: LiveBridge, clipIds: readonly ClipId[]): ScaleLockModalData {
  const overview = bridge.getSongOverview();
  const scale: Scale = { root: overview.rootNote, intervals: overview.scaleIntervals };
  let offScaleCount = 0;
  let noteCount = 0;
  for (const id of clipIds) {
    const notes = bridge.getNotes(id);
    noteCount += notes.length;
    offScaleCount += snapToScale(notes, scale, 'nearest').movedCount;
  }
  return {
    scaleLabel: scaleLabel(overview.rootNote, overview.scaleName),
    offScaleCount,
    noteCount,
  };
}

/** Compose a human scale label like `F Minor` from the root pitch class + scale name. */
function scaleLabel(rootNote: number, scaleName: string): string {
  const root = PITCH_CLASS_NAMES[((rootNote % 12) + 12) % 12] ?? '?';
  return scaleName.length > 0 ? `${root} ${scaleName}` : root;
}
