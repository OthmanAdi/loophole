/**
 * Session-to-Song Builder (W5, flagship) context-menu command, 03_EXTENSIONS_SPEC §4(c).
 *
 * Registers `"Build Arrangement from Session…"` on the `"Scene"` scope, shows the
 * section-map editor pre-filled with the Set's scene list, parses the `{ sections }`
 * the user laid out, and calls the pure-core {@link runSessionToSong} with the bridge.
 * The whole build is one undo (the handler clears the range, recreates each clip, and
 * writes the cue points inside one `LiveBridge.transaction`).
 *
 * The handler reads the entire Session itself, so this command does not need to resolve
 * the right-clicked Scene to anything: it only feeds the modal the scene names (so the
 * user can map sections to scenes) and forwards the resulting section map plus a 4/4
 * fallback time signature. A large build is wrapped in a progress dialog.
 *
 * SDK-facing; CI-excluded; typechecked locally via `tsconfig.live.json`.
 *
 * RING-3 PENDING (the flagged W5 de-risk): the create-then-populate one-undo grouping
 * inside a single transaction is confirmed only in real Live. The plan + write
 * orchestration is the ring-2 code exercised against `FakeLiveBridge`.
 */

import type { ExtensionContext } from '@ableton-extensions/sdk';
import {
  type LiveBridge,
  runSessionToSong,
  type SceneInfo,
  type Section,
  type TimeSig,
} from '@othmanadi/loophole-core';
import type { V } from '../adapter/resolver.js';
import { sceneReferenceForIndex } from './scene-selection.js';
import { TEMPLATES, dialogUrl } from '../webviews/index.js';
import { parseModalResult, runCommand } from './support.js';

const COMMAND_ID = 'loophole.s2s.build';
const LABEL = 'Build Arrangement from Session…';
const DIALOG_WIDTH = 640;
const DIALOG_HEIGHT = 520;

/** The 4/4 fallback the planner uses for any scene that reports no signature (§4(d)). */
const FALLBACK_TIME_SIG: TimeSig = { num: 4, den: 4 };

/** Above this section count the write is wrapped in a progress dialog. */
const PROGRESS_THRESHOLD = 4;

/** What the Session-to-Song modal posts back. `sections` is `null` on cancel. */
interface SessionToSongModalResult {
  readonly sections: readonly SectionInput[] | null;
}

/** One section row from the modal (the planner's {@link Section} shape, loosely typed). */
interface SectionInput {
  readonly name: string;
  readonly sceneIndex: number;
  readonly bars: number;
  readonly color?: number;
}

/** A `{ index, name }` scene the modal renders in each row's scene picker. */
interface SceneRow {
  readonly index: number;
  readonly name: string;
}

/**
 * Register the Session-to-Song command + its context-menu action on the Scene scope.
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
 * Show the section editor (seeded with the scene list), then build the arrangement on
 * Build. The handler reads the Session and writes everything in one undo; a build of
 * more than {@link PROGRESS_THRESHOLD} sections shows a progress dialog around it.
 */
async function handle(api: ExtensionContext<V>, bridge: LiveBridge): Promise<void> {
  const listedScenes = bridge.listScenes();
  const scenes: SceneRow[] = listedScenes.map((scene, index) => ({
    index,
    name: scene.name,
  }));

  const url = dialogUrl(TEMPLATES.sessionToSong, { scenes });
  const result = parseModalResult<SessionToSongModalResult>(
    await api.ui.showModalDialog(url, DIALOG_WIDTH, DIALOG_HEIGHT),
  );
  if (result === null || result.sections === null) {
    return; // cancelled
  }

  const sectionMap: Section[] = result.sections
    .filter((s) => s.name.trim().length > 0 && s.bars > 0)
    .map((section) => toSection(section, listedScenes));
  if (sectionMap.length === 0) {
    return; // nothing to build
  }

  const args = { sectionMap, timeSig: FALLBACK_TIME_SIG };
  if (sectionMap.length > PROGRESS_THRESHOLD) {
    await api.ui.withinProgressDialog('Building arrangement…', { progress: 0 }, async (update) => {
      await update('Placing clips and cue points…', 30);
      await runSessionToSong(bridge, args);
      await update('Done', 100);
    });
    return;
  }
  await runSessionToSong(bridge, args);
}

/** Build a {@link Section}, binding the modal's numeric choice to the opening scene snapshot. */
function toSection(input: SectionInput, openingScenes: readonly SceneInfo[]): Section {
  const base = {
    name: input.name.trim(),
    sceneRef: sceneReferenceForIndex(openingScenes, input.sceneIndex),
    bars: input.bars,
  };
  return input.color === undefined ? base : { ...base, color: input.color };
}
