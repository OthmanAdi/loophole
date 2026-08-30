/**
 * Humanize / Groove Sculptor context-menu command.
 *
 * Registers `"Humanize…"` on `"MidiClip"` and `"ClipSlotSelection"`, shows the Humanize
 * modal (strength / swing sliders, timing / velocity / duration checkboxes, living
 * toggle), parses the {@link HumanizeOpts}, and calls the pure-core {@link runHumanize}
 * with the bridge and an injected PRNG. One run is one undo.
 *
 * `rng` is injected, exactly as the transform requires for determinism: `activate()`
 * builds a real PRNG (seeded from `Math.random()` at boot) and passes it through here,
 * while SDK-free tests pass a fixed-seed PRNG to the handler directly. Threading a real
 * PRNG (rather than `Math.random` inline) keeps the SDK-facing shell consistent with
 * the tested contract.
 *
 * SDK-facing; CI-excluded; typechecked locally via `tsconfig.live.json`.
 *
 * Ableton runtime verification is NOT_RUN here: the scope argument shape, modal
 * round-trip, and undo grouping remain checks in the manual E2E checklist. The resolve
 * and handler path is covered by SDK-free tests.
 */

import type { ClipSlotSelection, ExtensionContext, Handle } from '@ableton-extensions/sdk';
import { type ClipId, type LiveBridge, runHumanize } from '@othmanadi/loophole-core';
import { clipIdFromHandle, midiClipIdsFromSlotSelection } from '../adapter/selection.js';
import { ReferenceService } from '../adapter/reference-service.js';
import type { V } from '../adapter/resolver.js';
import { TEMPLATES, dialogUrl } from '../webviews/index.js';
import { dispatchValidatedModal, validateHumanizeModal } from './modal-validation.js';
import { runCommand } from './support.js';

const COMMAND_ID = 'loophole.humanize.run';
const LABEL = 'Humanize…';
const DIALOG_WIDTH = 340;
const DIALOG_HEIGHT = 300;

/**
 * Register the Humanize command + its two context-menu actions.
 *
 * @param api the live SDK context.
 * @param bridge the real {@link LiveBridge} adapter.
 * @param rng the injected PRNG threaded into {@link runHumanize} (defaults to a
 *   `Math.random`-backed source; tests of the handler inject their own seeded PRNG).
 */
export function register(
  api: ExtensionContext<V>,
  bridge: LiveBridge,
  references: ReferenceService,
  rng: () => number = Math.random,
): void {
  api.commands.registerCommand(COMMAND_ID, (...args: unknown[]) => {
    void runCommand(LABEL, () => handle(api, bridge, references, rng, args[0]));
  });
  void api.ui.registerContextMenuAction('MidiClip', LABEL, COMMAND_ID);
  void api.ui.registerContextMenuAction('ClipSlotSelection', LABEL, COMMAND_ID);
}

async function handle(
  api: ExtensionContext<V>,
  bridge: LiveBridge,
  references: ReferenceService,
  rng: () => number,
  arg: unknown,
): Promise<void> {
  const clipIds = resolveClipIds(api, references, arg);
  if (clipIds.length === 0) {
    console.error('[loophole] Humanize: no MIDI clip in the selection.');
    return;
  }

  const url = dialogUrl(TEMPLATES.humanize, {});
  await dispatchValidatedModal(
    await api.ui.showModalDialog(url, DIALOG_WIDTH, DIALOG_HEIGHT),
    validateHumanizeModal,
    async (opts) => {
      await runHumanize(bridge, { clipIds, opts }, rng);
    },
  );
}

/** Turn the scope's argument into the list of MIDI clip ids to humanize. */
function resolveClipIds(
  api: ExtensionContext<V>,
  references: ReferenceService,
  arg: unknown,
): ClipId[] {
  if (isClipSlotSelection(arg)) {
    return midiClipIdsFromSlotSelection(api, references, arg);
  }
  const id = clipIdFromHandle(api, references, arg as Handle);
  return id === null ? [] : [id];
}

function isClipSlotSelection(arg: unknown): arg is ClipSlotSelection {
  return typeof arg === 'object' && arg !== null && 'selected_clip_slots' in arg;
}
