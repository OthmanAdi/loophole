/**
 * Session-to-Song Builder context-menu command.
 *
 * Registers `"Build Arrangement from Session…"` on the `"Scene"` scope, shows the
 * section-map editor pre-filled with the Set's scene list, parses the `{ sections }`
 * the user laid out, and calls the pure-core {@link runSessionToSong} with the bridge.
 * Mutations run in three ordered phases so clear, create, and populate operations cannot
 * race. A no-op creates no undo entries, a cue-only build creates two, and a build that
 * clears an occupied arrangement creates three.
 *
 * The handler reads the entire Session itself, so this command does not need to resolve
 * the right-clicked Scene to anything: it only feeds the modal the scene names (so the
 * user can map sections to scenes) and forwards the resulting section map plus a 4/4
 * fallback time signature. A large build is wrapped in a progress dialog.
 *
 * SDK-facing; CI-excluded; typechecked locally via `tsconfig.live.json`.
 *
 * Ableton runtime verification is NOT_RUN here: the ordered clear, create, and populate
 * phases and their undo restoration remain checks in the manual E2E checklist. Planning
 * and write orchestration are covered against `FakeLiveBridge`.
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
import {
  parseValidatedModal,
  validateSessionToSongModal,
  type ValidatedSectionInput,
} from './modal-validation.js';
import { runCommand } from './support.js';

const COMMAND_ID = 'loophole.s2s.build';
const LABEL = 'Build Arrangement from Session…';
const DIALOG_WIDTH = 640;
const DIALOG_HEIGHT = 520;

/** The 4/4 fallback the planner uses for any scene that reports no signature. */
const FALLBACK_TIME_SIG: TimeSig = { num: 4, den: 4 };

/** Above this section count the write is wrapped in a progress dialog. */
const PROGRESS_THRESHOLD = 4;

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
 * Build. The handler reads the Session and executes the ordered mutation phases; a
 * build of more than {@link PROGRESS_THRESHOLD} sections shows a progress dialog.
 */
async function handle(api: ExtensionContext<V>, bridge: LiveBridge): Promise<void> {
  const listedScenes = bridge.listScenes();
  const scenes: SceneRow[] = listedScenes.map((scene, index) => ({
    index,
    name: scene.name,
  }));

  const url = dialogUrl(TEMPLATES.sessionToSong, { scenes });
  const sections = parseValidatedModal(
    await api.ui.showModalDialog(url, DIALOG_WIDTH, DIALOG_HEIGHT),
    validateSessionToSongModal,
  );
  if (sections === null) return;

  const sectionMap: Section[] = sections
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
function toSection(input: ValidatedSectionInput, openingScenes: readonly SceneInfo[]): Section {
  const base = {
    name: input.name.trim(),
    sceneRef: sceneReferenceForIndex(openingScenes, input.sceneIndex),
    bars: input.bars,
  };
  return input.color === undefined ? base : { ...base, color: input.color };
}
