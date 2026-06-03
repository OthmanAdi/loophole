/**
 * Set Janitor (W6) context-menu command, 03_EXTENSIONS_SPEC §5(c).
 *
 * Registers `"Clean Up Set…"` on the `"Scene"` scope, reads the whole Set, runs the
 * pure-core {@link detectIssues} to build the checklist (destructive deletes off by
 * default), shows the grouped checklist modal, parses `{ chosenIssueIds }`, and calls
 * the pure-core {@link runSetJanitor} with the chosen ids. The whole sweep is one undo.
 *
 * Why a preview read here: the checklist must list the issues BEFORE the user picks,
 * but {@link runSetJanitor} re-detects internally and applies by chosen issue id. The
 * id scheme is content-derived and deterministic (`"<kind>:<target>"`, see
 * `transforms/janitor.ts`), so the ids shown in the modal round-trip exactly to the
 * ids the handler regenerates on its own second read. This command therefore builds a
 * small {@link SetDTO} for the preview (the same read the handler does), shows the
 * checklist, and forwards the chosen ids; it does not re-implement the fix logic.
 *
 * SDK-facing; CI-excluded; typechecked locally via `tsconfig.live.json`.
 *
 * RING-3 PENDING: the destructive deletes reverting in one undo, and the whole sweep
 * being one undo, are confirmed only in real Live. Detection + fix planning are the
 * ring-1/ring-2 code.
 */

import type { ExtensionContext } from '@ableton-extensions/sdk';
import {
  type ClipInfo,
  detectIssues,
  type Issue,
  type LiveBridge,
  runSetJanitor,
  type SetClipDTO,
  type SetDTO,
  type SetTrackDTO,
  type TrackInfo,
} from '@othmanadi/loophole-core';
import type { V } from '../adapter/resolver.js';
import { TEMPLATES, dialogUrl } from '../webviews/index.js';
import { parseModalResult, runCommand } from './support.js';

const COMMAND_ID = 'loophole.janitor.run';
const LABEL = 'Clean Up Set…';
const DIALOG_WIDTH = 560;
const DIALOG_HEIGHT = 460;

/** What the Set Janitor modal posts back. `chosenIssueIds` is `null` on cancel. */
interface SetJanitorModalResult {
  readonly chosenIssueIds: readonly string[] | null;
}

/** One issue row the modal renders (id + kind for grouping + a human detail line). */
interface IssueRow {
  readonly id: string;
  readonly kind: string;
  readonly detail: string;
}

/**
 * Register the Set Janitor command + its context-menu action.
 *
 * @param api the live SDK context.
 * @param bridge the real {@link LiveBridge} adapter.
 */
export function register(api: ExtensionContext<V>, bridge: LiveBridge): void {
  api.commands.registerCommand(COMMAND_ID, () => {
    void runCommand(LABEL, () => handle(api, bridge));
  });
  void api.ui.registerContextMenuAction('Scene', LABEL, COMMAND_ID);
}

/**
 * Read the Set, detect issues, show the checklist, then apply the chosen fixes via
 * {@link runSetJanitor} (which re-detects and matches by the same stable ids).
 */
async function handle(api: ExtensionContext<V>, bridge: LiveBridge): Promise<void> {
  const issues = detectIssues(readSet(bridge));
  const rows: IssueRow[] = issues.map(toIssueRow);

  const url = dialogUrl(TEMPLATES.setJanitor, { issues: rows });
  const result = parseModalResult<SetJanitorModalResult>(
    await api.ui.showModalDialog(url, DIALOG_WIDTH, DIALOG_HEIGHT),
  );
  if (result === null || result.chosenIssueIds === null) {
    return; // cancelled
  }
  if (result.chosenIssueIds.length === 0) {
    return; // nothing ticked
  }

  await runSetJanitor(bridge, { chosenIssueIds: result.chosenIssueIds });
}

/** Project an {@link Issue} to the minimal row the modal needs. */
function toIssueRow(issue: Issue): IssueRow {
  return { id: issue.id, kind: issue.kind, detail: issue.detail };
}

/**
 * Build the {@link SetDTO} the preview detection runs on, mirroring the handler's own
 * read (one `listTracks` + one `listClips` per track). Kept in sync with the handler's
 * `readSet` so the preview's issue ids match the handler's; the small duplication is
 * the accepted cost of previewing before the one-shot handler runs (the alternative,
 * exporting the handler's private read, widens the core surface for no gain).
 */
function readSet(bridge: LiveBridge): SetDTO {
  return {
    tracks: bridge.listTracks().map((track) => toSetTrack(track, bridge.listClips(track.id))),
  };
}

/** Build one {@link SetTrackDTO}, dropping empty Session slots (so empty = clip-free). */
function toSetTrack(track: TrackInfo, clips: readonly ClipInfo[]): SetTrackDTO {
  return {
    id: track.id,
    kind: track.kind,
    name: track.name,
    deviceCount: track.deviceCount,
    clips: clips.filter((clip) => clip.kind !== 'empty').map(toSetClip),
  };
}

/** Build one {@link SetClipDTO}, omitting `slotId` when absent. */
function toSetClip(clip: ClipInfo): SetClipDTO {
  const base = {
    id: clip.id,
    name: clip.name,
    color: clip.color,
    looping: clip.looping,
    loopStart: clip.loopStart,
    loopEnd: clip.loopEnd,
    endMarker: clip.endMarker,
  };
  return clip.slotId === undefined ? base : { ...base, slotId: clip.slotId };
}
