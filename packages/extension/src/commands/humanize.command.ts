/**
 * Humanize / Groove Sculptor (W2) context-menu command, 03_EXTENSIONS_SPEC §2(c).
 *
 * Registers `"Humanize…"` on `"MidiClip"` and `"ClipSlotSelection"`, shows the Humanize
 * modal (strength / swing sliders, timing / velocity / duration checkboxes, living
 * toggle), parses the {@link HumanizeOpts}, and calls the pure-core {@link runHumanize}
 * with the bridge and an injected PRNG. One run is one undo.
 *
 * `rng` is injected, exactly as the transform requires for determinism: `activate()`
 * builds a real PRNG (seeded from `Math.random()` at boot) and passes it through here,
 * while ring-2 tests pass a fixed-seed PRNG to the handler directly. Threading a real
 * PRNG (rather than `Math.random` inline) keeps the SDK-facing shell consistent with
 * the tested contract.
 *
 * SDK-facing; CI-excluded; typechecked locally via `tsconfig.live.json`.
 *
 * RING-3 PENDING: scope arg shape, modal round-trip, one-undo grouping — confirmed only
 * in real Live. The resolve + handler path is the ring-2 code.
 */

import type { ClipSlotSelection, ExtensionContext, Handle } from '@ableton-extensions/sdk';
import {
  type ClipId,
  type HumanizeOpts,
  type LiveBridge,
  runHumanize,
} from '@othmanadi/loophole-core';
import { clipIdFromHandle, midiClipIdsFromSlotSelection } from '../adapter/selection.js';
import type { V } from '../adapter/resolver.js';
import { TEMPLATES, dialogUrl } from '../webviews/index.js';
import { parseModalResult, runCommand } from './support.js';

const COMMAND_ID = 'loophole.humanize.run';
const LABEL = 'Humanize…';
const DIALOG_WIDTH = 340;
const DIALOG_HEIGHT = 300;

/**
 * What the Humanize modal posts back. `strength` is `null` on cancel; otherwise every
 * field is present (the modal always sends `swing` and `living` as concrete values, not
 * `undefined`), so they are typed REQUIRED here. That matters under
 * `exactOptionalPropertyTypes`: building {@link HumanizeOpts} from a `number | undefined`
 * would be rejected, but the modal guarantees concrete values.
 */
interface HumanizeModalApply {
  readonly strength: number;
  readonly swing: number;
  readonly doTiming: boolean;
  readonly doVelocity: boolean;
  readonly doDuration: boolean;
  readonly living: boolean;
}
type HumanizeModalResult = HumanizeModalApply | { readonly strength: null };

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
  rng: () => number = Math.random,
): void {
  api.commands.registerCommand(COMMAND_ID, (...args: unknown[]) => {
    void runCommand(LABEL, () => handle(api, bridge, rng, args[0]));
  });
  void api.ui.registerContextMenuAction('MidiClip', LABEL, COMMAND_ID);
  void api.ui.registerContextMenuAction('ClipSlotSelection', LABEL, COMMAND_ID);
}

async function handle(
  api: ExtensionContext<V>,
  bridge: LiveBridge,
  rng: () => number,
  arg: unknown,
): Promise<void> {
  const clipIds = resolveClipIds(api, arg);
  if (clipIds.length === 0) {
    console.error('[loophole] Humanize: no MIDI clip in the selection.');
    return;
  }

  const url = dialogUrl(TEMPLATES.humanize, {});
  const result = parseModalResult<HumanizeModalResult>(
    await api.ui.showModalDialog(url, DIALOG_WIDTH, DIALOG_HEIGHT),
  );
  if (result === null || result.strength === null) {
    return; // cancelled
  }

  const opts: HumanizeOpts = {
    strength: result.strength,
    swing: result.swing,
    doTiming: result.doTiming,
    doVelocity: result.doVelocity,
    doDuration: result.doDuration,
    living: result.living,
  };
  await runHumanize(bridge, { clipIds, opts }, rng);
}

/** Turn the scope's argument into the list of MIDI clip ids to humanize. */
function resolveClipIds(api: ExtensionContext<V>, arg: unknown): ClipId[] {
  if (isClipSlotSelection(arg)) {
    return midiClipIdsFromSlotSelection(api, arg);
  }
  const id = clipIdFromHandle(api, arg as Handle);
  return id === null ? [] : [id];
}

function isClipSlotSelection(arg: unknown): arg is ClipSlotSelection {
  return typeof arg === 'object' && arg !== null && 'selected_clip_slots' in arg;
}
