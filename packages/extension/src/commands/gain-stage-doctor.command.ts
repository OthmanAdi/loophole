/** Gain Stage Doctor modal command. The review dialog is shown before any mixer write. */

import { readFile } from 'node:fs/promises';
import decodeAudio from 'audio-decode';
import type { ArrangementSelection, ExtensionContext, Handle } from '@ableton-extensions/sdk';
import {
  analyzeGainStageDoctor,
  applyGainStageDoctor,
  type DecodeWav,
  type GainStageAnalysis,
  type LiveBridge,
  type TrackId,
} from '@othmanadi/loophole-core';
import {
  AudioTrack,
  audioTrackSelectionToTargets,
  trackIdFromHandle,
} from '../adapter/selection.js';
import { ReferenceService } from '../adapter/reference-service.js';
import type { V } from '../adapter/resolver.js';
import { TEMPLATES, dialogUrl } from '../webviews/index.js';
import { parseGainStageModalRequest } from './gain-stage-protocol.js';
import { parseModalResult, runCommand } from './support.js';

const COMMAND_ID = 'loophole.gsd.run';
const LABEL = 'Gain Stage…';
const DIALOG_WIDTH = 640;
const DIALOG_HEIGHT = 420;
const TARGET_OPTIONS = [-18, -20, -12] as const;

interface DecodedAudio {
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export function register(
  api: ExtensionContext<V>,
  bridge: LiveBridge,
  references: ReferenceService,
): void {
  api.commands.registerCommand(COMMAND_ID, (...args: unknown[]) => {
    void runCommand(LABEL, () => handle(api, bridge, references, args[0]));
  });
  void api.ui.registerContextMenuAction('AudioTrack', LABEL, COMMAND_ID);
  void api.ui.registerContextMenuAction('AudioTrack.ArrangementSelection', LABEL, COMMAND_ID);
}

async function handle(
  api: ExtensionContext<V>,
  bridge: LiveBridge,
  references: ReferenceService,
  arg: unknown,
): Promise<void> {
  const trackIds = resolveTrackIds(api, references, arg);
  if (trackIds.length === 0) {
    console.error('[loophole] Gain Stage: no audio track in the selection.');
    return;
  }
  const start = parseGainStageModalRequest(
    parseModalResult<unknown>(
      await api.ui.showModalDialog(
        dialogUrl(TEMPLATES.gainStage, {
          mode: 'configure',
          tracks: trackIds.map((id) => ({ id, name: trackName(bridge, id) })),
          targets: TARGET_OPTIONS,
        }),
        DIALOG_WIDTH,
        DIALOG_HEIGHT,
      ),
    ),
  );
  if (start === null || start.phase !== 'analyze') return;

  // Ignore arbitrary UI identifiers: only refs that were in this invocation's selection
  // can enter the read-only plan.
  const selected = trackIds.filter((id) => start.trackIds.includes(id));
  if (selected.length === 0) return;
  const progressResult: unknown = await api.ui.withinProgressDialog(
    'Measuring tracks…',
    { progress: 0 },
    async (update, signal): Promise<GainStageAnalysis | null> => {
      await update('Rendering and measuring…', 20);
      if (signal.aborted) return null;
      const plan = await analyzeGainStageDoctor(
        bridge,
        { trackIds: selected, targetDb: start.targetDb },
        makeDecode(),
      );
      await update('Preparing review…', 90);
      return plan;
    },
  );
  const analysis = progressResult as GainStageAnalysis | null | undefined;
  if (analysis === null || analysis === undefined) return;

  const review = parseGainStageModalRequest(
    parseModalResult<unknown>(
      await api.ui.showModalDialog(
        dialogUrl(TEMPLATES.gainStage, {
          mode: 'review',
          targetDb: analysis.targetDb,
          proposals: analysis.proposals.map((proposal) => ({
            track: proposal.track,
            peakDb: proposal.peakDb,
            rmsDb: proposal.rmsDb,
            crest: proposal.crest,
            trimDb: proposal.trimDb,
            status: proposal.status,
          })),
        }),
        DIALOG_WIDTH,
        DIALOG_HEIGHT,
      ),
    ),
  );
  if (review === null || review.phase !== 'apply') return;

  await api.ui.withinProgressDialog('Applying proposed trims…', { progress: 0 }, async (update) => {
    await update('Validating reviewed targets…', 25);
    await applyGainStageDoctor(bridge, analysis);
    await update('Applied one undo step.', 100);
  });
}

function resolveTrackIds(
  api: ExtensionContext<V>,
  references: ReferenceService,
  arg: unknown,
): TrackId[] {
  if (isArrangementSelection(arg))
    return audioTrackSelectionToTargets(api, references, arg).trackIds;
  const handle = arg as Handle;
  const id = trackIdFromHandle(api, references, handle);
  if (id === null) return [];
  return api.getObjectFromHandle(handle, AudioTrack) instanceof AudioTrack ? [id] : [];
}

function isArrangementSelection(arg: unknown): arg is ArrangementSelection {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    'selected_lanes' in arg &&
    'time_selection_start' in arg
  );
}

function trackName(bridge: LiveBridge, id: TrackId): string {
  return bridge.listTracks().find((track) => track.id === id)?.name ?? id;
}

function makeDecode(): DecodeWav {
  return async (wavPath: string): Promise<Float32Array[]> => {
    const decoded = (await decodeAudio(await readFile(wavPath))) as DecodedAudio;
    return Array.from({ length: decoded.numberOfChannels }, (_, channel) =>
      decoded.getChannelData(channel),
    );
  };
}
